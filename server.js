const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const multer = require("multer");

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || "https://twitch-photo.onrender.com";
const DEFAULT_DB = process.env.DATABASE_FILE || "/var/data/twitch-photo.db";

const TWITCH_APP_CLIENT_ID = process.env.TWITCH_APP_CLIENT_ID || "";
const TWITCH_APP_CLIENT_SECRET = process.env.TWITCH_APP_CLIENT_SECRET || "";
const EXTENSION_OWNER_USER_ID = process.env.EXTENSION_OWNER_USER_ID || "";
const EBS_JWT_SECRET = process.env.EBS_JWT_SECRET || "change-me";

let DB_FILE = DEFAULT_DB;
try { fs.mkdirSync(path.dirname(DEFAULT_DB), { recursive: true }); }
catch (e) { if (e.code === "EACCES" || e.code === "EPERM") { DB_FILE = "/tmp/twitch-photo.db"; } else { throw e; }}

const UPLOAD_ROOT_DEFAULT = "/var/data/uploads";
let UPLOAD_ROOT = UPLOAD_ROOT_DEFAULT;
try { fs.mkdirSync(UPLOAD_ROOT_DEFAULT, { recursive: true }); }
catch (e) { if (e.code === "EACCES" || e.code === "EPERM") { UPLOAD_ROOT = "/tmp/uploads"; fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } else { throw e; }}

const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT DEFAULT '',
    likes_count INTEGER DEFAULT 0,
    tip_bits_total INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    message TEXT NOT NULL,
    bits INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(UPLOAD_ROOT, { maxAge: "30d", immutable: true }));

function decode(auth){
  if(!auth) return {};
  const token = auth.replace(/^Bearer\s+/i,"");
  try { const d = jwt.decode(token)||{}; return { token, ...d }; } catch { return {}; }
}
const ok=(res,data)=>res.json(data||{ok:true});
const bad=(res,msg,code=400)=>res.status(code).json({error:msg||"bad_request"});

app.get("/health",(req,res)=>ok(res,{ok:true,db:DB_FILE,uploads:UPLOAD_ROOT}));
app.get("/api/status",(req,res)=>{
  const a=decode(req.headers.authorization);
  const role=a.role||"viewer";
  const isSubscriber = (role==="broadcaster"||role==="moderator"); // bypass for owner/mods
  ok(res,{role,isSubscriber,channel_id:a.channel_id||null,user_id:a.user_id||null});
});

app.get("/api/photos",(req,res)=>{
  const rows = db.prepare("SELECT id,url,title,likes_count,tip_bits_total,created_at FROM photos ORDER BY id DESC").all();
  ok(res, rows);
});
app.post("/api/admin/photos",(req,res)=>{
  const a=decode(req.headers.authorization);
  const role=a.role||"viewer"; if(!["broadcaster","moderator"].includes(role)) return bad(res,"forbidden",403);
  const { url, title="" } = req.body||{};
  if(!url || !/^https:\/\/.+/i.test(url)) return bad(res,"direct https image url required");
  const r = db.prepare("INSERT INTO photos(url,title) VALUES(?,?)").run(url,title);
  const row = db.prepare("SELECT id,url,title,likes_count,tip_bits_total,created_at FROM photos WHERE id=?").get(r.lastInsertRowid);
  ok(res,{photo:row});
});
app.delete("/api/admin/photos/:id",(req,res)=>{
  const a=decode(req.headers.authorization);
  const role=a.role||"viewer"; if(!["broadcaster","moderator"].includes(role)) return bad(res,"forbidden",403);
  const id = Number(req.params.id||0); if(!id) return bad(res,"invalid id");
  const p = db.prepare("SELECT url FROM photos WHERE id=?").get(id);
  db.prepare("DELETE FROM photos WHERE id=?").run(id);
  db.prepare("DELETE FROM comments WHERE photo_id=?").run(id);
  if(p && p.url && p.url.startsWith(BASE_URL+"/uploads/")){
    const filePath = path.join(UPLOAD_ROOT, path.basename(p.url));
    fs.promises.unlink(filePath).catch(()=>{});
  }
  ok(res,{deleted:id});
});

const multer = require("multer"); // ensured
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname||"").toLowerCase() || ".png";
    const name = "img_"+Date.now()+"_"+Math.random().toString(36).slice(2,8)+ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = ["image/png","image/jpeg","image/webp","image/gif"];
    if(okTypes.includes(file.mimetype)) cb(null,true);
    else cb(new Error("Only png/jpeg/webp/gif images are allowed"));
  }
});

app.post("/api/admin/upload", upload.single("image"), (req,res)=>{
  const a=decode(req.headers.authorization);
  const role=a.role||"viewer"; if(!["broadcaster","moderator"].includes(role)) return bad(res,"forbidden",403);
  if(!req.file) return bad(res,"no file");
  const title = (req.body && req.body.title) ? String(req.body.title).slice(0,120) : "";
  const url = `${BASE_URL}/uploads/${encodeURIComponent(req.file.filename)}`;
  const r = db.prepare("INSERT INTO photos(url,title) VALUES(?,?)").run(url,title);
  const row = db.prepare("SELECT id,url,title,likes_count,tip_bits_total,created_at FROM photos WHERE id=?").get(r.lastInsertRowid);
  ok(res,{photo:row});
});

function bitsFromSku(sku){ const m=String(sku||'').match(/(\d+)/); return m?parseInt(m[1],10)||0:0; }
app.post("/api/like",(req,res)=>{
  const { photoId, bits=0 } = req.body||{}; const id=Number(photoId||0); if(!id) return bad(res,"invalid id");
  const r=db.prepare("UPDATE photos SET likes_count=likes_count+1, tip_bits_total=tip_bits_total+? WHERE id=?").run(bits,id);
  if(!r.changes) return bad(res,"not found",404); ok(res,{liked:id,bitsAdded:bits});
});
app.post("/api/comment_with_purchase",(req,res)=>{
  const a=decode(req.headers.authorization);
  const user=a.user_id||"viewer";
  const { photoId, comment="" } = req.body||{}; const id=Number(photoId||0);
  if(!id || !comment.trim()) return bad(res,"photoId and comment required");
  db.prepare("INSERT INTO comments(photo_id,username,message,bits) VALUES(?,?,?,0)").run(id,user,String(comment).slice(0,500));
  ok(res,{commented:id});
});
app.post("/api/transactions/complete",(req,res)=>{
  const { onReceipt={}, photoId, comment="" } = req.body||{}; const id=Number(photoId||0);
  if(!id) return bad(res,"invalid id");
  const bits=bitsFromSku(onReceipt.sku||"");
  db.prepare("UPDATE photos SET likes_count=likes_count+1, tip_bits_total=tip_bits_total+? WHERE id=?").run(bits,id);
  if(comment.trim()) db.prepare("INSERT INTO comments(photo_id,username,message,bits) VALUES(?,?,?,?)").run(id,"viewer",String(comment).slice(0,500),bits||500);
  ok(res,{applied:true,bits});
});

app.get("/auth/login",(req,res)=>{
  const redirectUri = `${BASE_URL}/auth/callback`;
  const scope = encodeURIComponent("channel:read:subscriptions chat:read chat:edit");
  const url=`https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_APP_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
  res.redirect(url);
});
app.get("/auth/callback", async (req,res)=>{
  if(!req.query.code) return res.status(400).send("Missing code");
  const redirectUri = `${BASE_URL}/auth/callback`;
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token",{
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id: TWITCH_APP_CLIENT_ID, client_secret: TWITCH_APP_CLIENT_SECRET,
      code: req.query.code, grant_type: "authorization_code", redirect_uri: redirectUri
    })
  });
  const tokenJson = await tokenRes.json().catch(()=>({}));
  res.send(`<html><body style="font-family:ui-sans-serif;padding:16px">
    <h3>Connected ✔</h3><pre>${String(JSON.stringify(tokenJson,null,2)).replace(/[&<>]/g,s=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[s]))}</pre>
    <p>You can close this window.</p></body></html>`);
});

app.listen(PORT,()=>console.log("EBS listening on",PORT,"DB:",DB_FILE,"Uploads:",UPLOAD_ROOT));
