import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'csv-parse/sync';
import { User, Student, PracticeRecord, Competition, WinnerApproval, AuditLog } from './models.js';

const app = express();
const httpServer = createServer(app);
const liveTickets = new Map();
let leaderboardSockets;
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
function broadcastLeaderboardUpdate(){if(!leaderboardSockets)return;const message=JSON.stringify({type:'leaderboard:update',updatedAt:Date.now()});for(const client of leaderboardSockets.clients)if(client.readyState===WebSocket.OPEN)client.send(message);}
function disconnectStudentSockets(studentId){for(const [key,ticket] of liveTickets)if(ticket.studentId===studentId)liveTickets.delete(key);for(const client of webSocketServer.clients)if(client.studentId===studentId)client.close(1000,'Student account is no longer active');}
httpServer.on('upgrade',(req,socket,head)=>{let url;try{url=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}if(url.pathname!=='/api/live'){socket.destroy();return;}const origin=req.headers.origin;if(origin&&!allowedOrigins.includes(origin)){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}const ticket=url.searchParams.get('ticket'),session=liveTickets.get(ticket);if(!session||session.expiresAt<Date.now()){if(ticket)liveTickets.delete(ticket);socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}liveTickets.delete(ticket);webSocketServer.handleUpgrade(req,socket,head,ws=>{ws.sessionId=session.sessionId;ws.studentId=session.studentId;webSocketServer.emit('connection',ws,req);});});
webSocketServer.on('connection',ws=>{ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true;});});
setInterval(()=>{for(const client of webSocketServer.clients){if(!client.isAlive){client.terminate();continue;}client.isAlive=false;client.ping();}},30000).unref();
const port = Number(process.env.PORT || 4000);
const allowedOrigins = (process.env.APP_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim());
app.disable('x-powered-by');
// Render terminates TLS at its proxy; trust it so Express can issue Secure cookies.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204); next();
});
app.use(express.json({ limit: '1mb' }));
const prod = process.env.NODE_ENV === 'production';
const sessionTtlSeconds=60*60*24*30;
app.use(session({ name: 'practicehub.sid', secret: process.env.SESSION_SECRET || 'local-dev-only-change-me', resave: false, saveUninitialized: false, rolling: true, cookie: { httpOnly: true, sameSite: prod ? 'none' : 'lax', secure: prod, maxAge: 1000 * sessionTtlSeconds }, store: process.env.MONGODB_URI ? MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'sessions', ttl: sessionTtlSeconds }) : undefined }));
const cloudinaryUrl = process.env.CLOUDINARY_URL;
if (cloudinaryUrl) {
  const parsedCloudinaryUrl = new URL(cloudinaryUrl);
  cloudinary.config({ cloud_name: parsedCloudinaryUrl.hostname, api_key: decodeURIComponent(parsedCloudinaryUrl.username), api_secret: decodeURIComponent(parsedCloudinaryUrl.password), secure: true });
} else {
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
}
const allowedScreenshotTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  if (allowedScreenshotTypes.includes(file.mimetype)) return cb(null, true);
  cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
} });
const profileImageTypes = ['image/png', 'image/jpeg', 'image/webp'];
const uploadProfileImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  if (profileImageTypes.includes(file.mimetype)) return cb(null, true);
  const error = new Error('Profile picture must be PNG, JPG, or WebP'); error.statusCode = 400; cb(error);
} });

async function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Sign in required' });
  req.user = req.session.user;
  if (req.user.role === 'student') {
    try {
      const active = await Student.exists({ _id: req.user.student, enrollmentStatus: 'Active' });
      if (!active) {
        return req.session.destroy(() => { res.clearCookie('practicehub.sid'); res.status(401).json({ error: 'This student account is no longer active' }); });
      }
    } catch (error) { return fail(res, error); }
  }
  next();
}
function roles(...allowed) { return (req, res, next) => allowed.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Insufficient permissions' }); }
function fail(res, error) { if (error?.code === 11000) return res.status(409).json({ error: 'A matching record already exists' }); if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message }); if (error?.name === 'ValidationError' || error?.name === 'CastError') return res.status(400).json({ error: error.message }); console.error(error); return res.status(500).json({ error: 'Unable to complete request' }); }
function establishSession(req, user) { return new Promise((resolve, reject) => { req.session.regenerate(error => { if (error) return reject(error); req.session.user = user; req.session.save(saveError => saveError ? reject(saveError) : resolve(user)); }); }); }
const recordQuery = { status: 'Published' };
const getWeek = (start, end) => ({ $gte: new Date(start), $lte: new Date(`${end}T23:59:59.999Z`) });

app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
app.post('/api/auth/login', async (req, res) => { try { const email = String(req.body.email || '').trim().toLowerCase(); const user = email === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase() ? await User.findOne({ email, active: true, role: 'coordinator' }) : null; if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password' }); const sessionUser = await establishSession(req, { id: user.id, name: user.name, email: user.email, role: user.role }); res.json({ user: sessionUser }); } catch (e) { fail(res, e); } });
app.post('/api/auth/student-login', async (req, res) => { try { const name=String(req.body.name||'').trim(); const phone=String(req.body.phone||'').replace(/\D/g,''); if(name.length<2||name.length>120||phone.length<10||phone.length>15)return res.status(400).json({error:'Enter your full name and a valid phone number'}); let student=await Student.findOne({fullName:new RegExp(`^${escapeRegex(name)}$`,'i'),phone,enrollmentStatus:'Active'}); if(!student)return res.status(401).json({error:'Name and phone number did not match an active student'}); if(!student.accountActivatedAt){student.accountActivatedAt=new Date();await student.save();} student=student.toObject(); const sessionUser = await establishSession(req, { id:String(student._id),student:String(student._id),name:student.fullName,role:'student' }); res.json({user:sessionUser}); } catch(e){fail(res,e);} });
app.post('/api/auth/student-register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim(), phone = String(req.body.phone || '').replace(/\D/g, '');
    if (name.length < 2 || name.length > 120 || phone.length < 10 || phone.length > 15) return res.status(400).json({ error: 'Enter your full name and a phone number with 10 to 15 digits' });
    let student = await Student.findOne({ fullName: new RegExp(`^${escapeRegex(name)}$`, 'i'), phone });
    if (student) {
      if (student.enrollmentStatus !== 'Active') return res.status(403).json({ error: 'This student account is inactive. Contact the administrator.' });
      if (student.accountActivatedAt || student.batch === 'Self-registered') return res.status(409).json({ error: 'This student account has already been created. Use Student login instead.' });
      student = await Student.findOneAndUpdate({ _id: student._id, enrollmentStatus: 'Active', accountActivatedAt: { $exists: false } }, { $set: { accountActivatedAt: new Date() } }, { new: true });
      if (!student) return res.status(409).json({ error: 'This student account has already been created. Use Student login instead.' });
    } else {
      const id = `SELF-${randomUUID()}`;
      student = await Student.create({ studentId: id, fullName: name, rollNumber: id, batch: 'Self-registered', phone, accountActivatedAt: new Date(), enrollmentStatus: 'Active' });
    }
    const sessionUser = await establishSession(req, { id: String(student._id), student: String(student._id), name: student.fullName, role: 'student' });
    res.status(201).json({ user: sessionUser });
  } catch (e) { fail(res, e); }
});
app.post('/api/auth/logout', auth, (req, res) => {for(const client of webSocketServer.clients)if(client.sessionId===req.sessionID)client.close(1000,'Signed out');req.session.destroy(() => { res.clearCookie('practicehub.sid'); res.sendStatus(204); });});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/live-ticket',auth,(req,res)=>{for(const [key,value] of liveTickets)if(value.expiresAt<Date.now())liveTickets.delete(key);const ticket=randomUUID();liveTickets.set(ticket,{sessionId:req.sessionID,studentId:req.user.role==='student'?String(req.user.student):null,expiresAt:Date.now()+30000});res.json({ticket});});
app.post('/api/users', auth, roles('coordinator'), async (req, res) => { try { const { name, email, password, role } = req.body; if (!name || !email || !password || !['coordinator', 'faculty', 'student'].includes(role)) return res.status(400).json({ error: 'Name, email, password, and a valid role are required' }); const user = await User.create({ name, email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), role, student: req.body.student || undefined }); res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role }); } catch (e) { fail(res, e); } });

app.get('/api/students', auth, async (req, res) => { try { const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25)); const q = String(req.query.q || '').trim(); const filter = { ...(q ? { $or: [{ fullName: new RegExp(escapeRegex(q), 'i') }, { rollNumber: new RegExp(escapeRegex(q), 'i') }] } : {}), ...(req.query.status ? { enrollmentStatus: req.query.status } : {}) }; if (req.user.role === 'student') filter._id = req.user.student; const [rows, total] = await Promise.all([Student.find(filter).sort({ fullName: 1 }).skip((page - 1) * limit).limit(limit).lean(), Student.countDocuments(filter)]); res.json({ rows, total, page, pages: Math.ceil(total / limit) }); } catch (e) { fail(res, e); } });
app.post('/api/students', auth, roles('coordinator'), async (req, res) => { try { const fullName=String(req.body.fullName||'').trim(); const phone=String(req.body.phone||'').replace(/\D/g,''); if(fullName.length<2||fullName.length>120||phone.length<10||phone.length>15)return res.status(400).json({error:'Enter a full name and a phone number with 10 to 15 digits'}); const duplicate=await Student.findOne({fullName:new RegExp(`^${escapeRegex(fullName)}$`,'i'),phone,enrollmentStatus:'Active'}); if(duplicate)return res.status(409).json({error:'This student is already in the directory. They can sign in with this name and phone number.'}); const id=`ADM-${randomUUID()}`; const student=await Student.create({studentId:id,fullName,rollNumber:id,batch:'Admin-added',phone,enrollmentStatus:'Active'}); res.status(201).json(student); } catch (e) { fail(res, e); } });
app.patch('/api/students/:id', auth, roles('coordinator'), async (req, res) => {
  try {
    const row = await Student.findById(req.params.id);
    if (!row) return res.sendStatus(404);
    const fullName = String(req.body.fullName ?? row.fullName).trim();
    const phone = String(req.body.phone ?? row.phone ?? '').replace(/\D/g, '');
    const enrollmentStatus = req.body.enrollmentStatus ?? row.enrollmentStatus;
    if (fullName.length < 2 || fullName.length > 120 || phone.length < 10 || phone.length > 15) {
      return res.status(400).json({ error: 'Enter a full name and a phone number with 10 to 15 digits' });
    }
    if (!['Active', 'Inactive', 'Graduated'].includes(enrollmentStatus)) {
      return res.status(400).json({ error: 'Choose a valid student status' });
    }
    const duplicate = await Student.findOne({ _id: { $ne: row._id }, fullName: new RegExp(`^${escapeRegex(fullName)}$`, 'i'), phone, enrollmentStatus: 'Active' });
    if (duplicate && enrollmentStatus === 'Active') {
      return res.status(409).json({ error: 'Another active student already uses this name and phone number' });
    }
    row.fullName = fullName;
    row.phone = phone;
    row.enrollmentStatus = enrollmentStatus;
    await row.save();
    if (enrollmentStatus !== 'Active') disconnectStudentSockets(String(row._id));
    broadcastLeaderboardUpdate();
    res.json(row);
  } catch (e) { fail(res, e); }
});
app.delete('/api/students/:id', auth, roles('coordinator'), async (req, res) => {
  try {
    const student = await Student.findById(req.params.id).lean();
    if (!student) return res.sendStatus(404);
    const records = await PracticeRecord.find({ student: student._id }).select('screenshot.publicId').lean();
    await Promise.all([
      PracticeRecord.deleteMany({ student: student._id }),
      WinnerApproval.deleteMany({ candidate: student._id }),
      Competition.updateMany({ officialWinner: student._id }, { $unset: { officialWinner: 1, announcementPublished: 1 } }),
      User.deleteMany({ student: student._id })
    ]);
    await Student.deleteOne({ _id: student._id });
    disconnectStudentSockets(String(student._id));
    broadcastLeaderboardUpdate();
    const publicIds = [...records.map(record => record.screenshot?.publicId).filter(Boolean), student.photoPublicId].filter(Boolean);
    await Promise.allSettled(publicIds.map(publicId => cloudinary.uploader.destroy(publicId)));
    res.sendStatus(204);
  } catch (e) { fail(res, e); }
});
app.post('/api/students/import', auth, roles('coordinator'), async (req, res) => { try { if (typeof req.body.csv !== 'string' || req.body.csv.length > 5_000_000) return res.status(400).json({ error: 'CSV is missing or exceeds 5 MB' }); const rows = parse(req.body.csv, { columns: true, skip_empty_lines: true, trim: true, bom: true }); const clean = rows.map(r => ({ studentId: r.studentId || r['Student ID'], fullName: r.fullName || r['Full Name'] || r.name, rollNumber: r.rollNumber || r['Roll Number'], batch: r.batch || r['Batch / Section'] || r.section, phone: String(r.phone || r.Phone || '').replace(/\D/g,''), email: r.email || r.Email || undefined, enrollmentStatus: r.enrollmentStatus || 'Active' })).filter(r => r.studentId && r.fullName && r.rollNumber); const ops = clean.map(doc => ({ updateOne: { filter: { $or: [{ studentId: doc.studentId }, { rollNumber: doc.rollNumber }] }, update: { $setOnInsert: doc }, upsert: true } })); const result = ops.length ? await Student.bulkWrite(ops, { ordered: false }) : { upsertedCount: 0, matchedCount: 0 }; res.json({ imported: result.upsertedCount, alreadyPresent: result.matchedCount, ignored: rows.length - clean.length }); } catch (e) { fail(res, e); } });
app.get('/api/students/:id', auth, async (req, res) => { try { if (req.user.role === 'student' && req.user.student !== req.params.id) return res.sendStatus(403); const student = await Student.findById(req.params.id).lean(); if (!student) return res.sendStatus(404); const records = await PracticeRecord.find({ student: student._id, ...recordQuery }).sort({ practiceDate: -1 }).limit(300).lean(); res.json({ student, records }); } catch (e) { fail(res, e); } });
app.post('/api/students/me/profile-picture', auth, roles('student'), uploadProfileImage.single('profilePicture'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPG, or WebP profile picture' });
    if (!(process.env.CLOUDINARY_CLOUD_NAME || cloudinary.config().cloud_name)) return res.status(503).json({ error: 'Profile picture storage is not configured on the backend' });
    const student = await Student.findById(req.user.student);
    if (!student) return res.sendStatus(404);
    const image = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'practicehub/profiles', resource_type: 'image' }, (err, result) => err ? reject(err) : resolve(result));
      Readable.from(req.file.buffer).pipe(stream);
    });
    const previousPhotoId = student.photoPublicId;
    student.photoUrl = image.secure_url;
    student.photoPublicId = image.public_id;
    await student.save();
    broadcastLeaderboardUpdate();
    if (previousPhotoId) cloudinary.uploader.destroy(previousPhotoId, { resource_type: 'image' }).catch(() => {});
    res.json({ student: { id: String(student._id), fullName: student.fullName, photoUrl: student.photoUrl } });
  } catch (e) { fail(res, e); }
});

async function uploadScreenshot(file) {
  if (!file) return null;
  if (!(process.env.CLOUDINARY_CLOUD_NAME || cloudinary.config().cloud_name)) {
    const error = new Error('Screenshot storage is not configured. Add CLOUDINARY_URL in the backend environment.');
    error.statusCode = 503;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder: 'practicehub/results', resource_type: 'auto', access_mode: 'authenticated' }, (err, result) => err ? reject(err) : resolve({ publicId: result.public_id, secureUrl: result.secure_url, format: result.format }));
    Readable.from(file.buffer).pipe(stream);
  });
}
function normalizedScreenshotCount(value, hasFile, fallback = 0) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const count = raw === '' ? (hasFile ? Math.max(1, Number(fallback) || 0) : Number(fallback) || 0) : Number(raw);
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    const error = new Error('Screenshot count must be a whole number from 0 to 1000');
    error.statusCode = 400;
    throw error;
  }
  return Math.max(count, hasFile ? 1 : 0);
}
app.get('/api/records', auth, async (req, res) => { try { const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Number(req.query.limit) || 25); const filter = { ...(req.user.role === 'student' ? { student: req.user.student } : {}), ...(req.query.module ? { module: req.query.module } : {}), ...(req.query.status && req.user.role !== 'student' ? { status: req.query.status } : {}), ...(req.query.start && req.query.end ? { practiceDate: getWeek(req.query.start, req.query.end) } : {}) }; const [rows,total]=await Promise.all([PracticeRecord.find(filter).populate('student','fullName studentId photoUrl batch').sort({practiceDate:-1,practiceTime:-1}).skip((page-1)*limit).limit(limit).lean(),PracticeRecord.countDocuments(filter)]); res.json({rows,total,page,pages:Math.ceil(total/limit)}); } catch(e){fail(res,e);} });
app.post('/api/records', auth, roles('coordinator'), upload.single('screenshot'), async (req,res)=>{try{const score=Number(req.body.score);if(!Number.isFinite(score)||score<0||score>50)return res.status(400).json({error:'Score must be between 0 and 50'});const body={...req.body,student:req.body.studentId,coordinator:req.user.id,practiceDate:new Date(`${req.body.practiceDate}T${req.body.practiceTime||'12:00'}:00`),maxScore:50,score,screenshotCount:normalizedScreenshotCount(req.body.screenshotCount,Boolean(req.file))};body.dayOfWeek=body.practiceDate.toLocaleDateString('en-US',{weekday:'long',timeZone:'UTC'});body.percentage=Number((body.score/body.maxScore*100).toFixed(2));body.screenshot=req.file?await uploadScreenshot(req.file):undefined;const row=await PracticeRecord.create(body);broadcastLeaderboardUpdate();res.status(201).json(row);}catch(e){fail(res,e);}});
app.patch('/api/records/:id', auth, roles('coordinator'), upload.single('screenshot'), async (req,res)=>{try{
  const old=await PracticeRecord.findById(req.params.id);if(!old)return res.sendStatus(404);
  const previous={student:String(old.student),module:old.module,score:old.score,maxScore:old.maxScore,percentage:old.percentage,screenshotCount:old.screenshotCount||0,practiceDate:old.practiceDate,practiceTime:old.practiceTime,dayOfWeek:old.dayOfWeek,status:old.status};
  if(req.body.studentId!==undefined)old.student=req.body.studentId;
  for(const key of ['module','practiceTime','duration','remarks','status'])if(req.body[key]!==undefined)old[key]=req.body[key];
  if(req.body.score!==undefined)old.score=Number(req.body.score);
  if(req.body.maxScore!==undefined)old.maxScore=Number(req.body.maxScore);
  if(req.body.screenshotCount!==undefined||req.file)old.screenshotCount=normalizedScreenshotCount(req.body.screenshotCount,Boolean(req.file),old.screenshotCount||(old.screenshot?.publicId?1:0));
  if(req.body.practiceDate!==undefined){const date=String(req.body.practiceDate);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:'Choose a valid practice date'});old.practiceDate=new Date(`${date}T${req.body.practiceTime||old.practiceTime||'12:00'}:00`);}
  if(req.body.practiceTime!==undefined&&req.body.practiceDate===undefined){const date=new Date(old.practiceDate).toISOString().slice(0,10);old.practiceDate=new Date(`${date}T${req.body.practiceTime}:00`);}
  if(!Number.isFinite(old.score)||!Number.isFinite(old.maxScore)||old.score<0||old.maxScore<=0||old.score>old.maxScore)return res.status(400).json({error:'Score must be between zero and the maximum score'});
  if(Number.isNaN(old.practiceDate.getTime()))return res.status(400).json({error:'Choose a valid practice date'});
  old.dayOfWeek=old.practiceDate.toLocaleDateString('en-US',{weekday:'long',timeZone:'UTC'});
  old.percentage=Number((old.score/old.maxScore*100).toFixed(2));
  if(req.file)old.screenshot=await uploadScreenshot(req.file);
  old.coordinator=req.user.id;await old.save();broadcastLeaderboardUpdate();
  const updated={student:String(old.student),module:old.module,score:old.score,maxScore:old.maxScore,percentage:old.percentage,screenshotCount:old.screenshotCount||0,practiceDate:old.practiceDate,practiceTime:old.practiceTime,dayOfWeek:old.dayOfWeek,status:old.status};
  if(JSON.stringify(previous)!==JSON.stringify(updated)){await AuditLog.create({record:old._id,actor:req.user.id,action:'score_corrected',previous,updated});if(old.status==='Published'&&previous.status!=='Published')await AuditLog.create({record:old._id,actor:req.user.id,action:'record_published',updated});}
  res.json(old);
}catch(e){fail(res,e);}});
app.delete('/api/records/:id', auth, roles('coordinator'), async(req,res)=>{try{const row=await PracticeRecord.findById(req.params.id);if(!row)return res.sendStatus(404);await AuditLog.create({record:row._id,actor:req.user.id,action:'record_deleted',previous:{score:row.score,maxScore:row.maxScore,status:row.status}});await row.deleteOne();broadcastLeaderboardUpdate();res.sendStatus(204);}catch(e){fail(res,e);}});
app.get('/api/records/:id/audit', auth, roles('coordinator','faculty'), async(req,res)=>{try{res.json(await AuditLog.find({record:req.params.id}).populate('actor','name role').sort({createdAt:-1}).lean());}catch(e){fail(res,e);}});

app.get('/api/leaderboard', auth, async(req,res)=>{try{
  const filter={...recordQuery};if(req.query.start&&req.query.end)filter.practiceDate=getWeek(req.query.start,req.query.end);if(['Aptitude','Mock Interview'].includes(req.query.module))filter.module=req.query.module;
  const rankByBest=req.query.sort==='best';
  const rows=await PracticeRecord.aggregate([
    {$match:filter},{$sort:{student:1,percentage:-1,practiceDate:-1}},
    {$group:{_id:'$student',attempts:{$sum:1},total:{$sum:'$percentage'},scoreTotal:{$sum:'$score'},scales:{$addToSet:'$maxScore'},best:{$first:'$percentage'},bestPoints:{$first:'$score'},bestMaxScore:{$first:'$maxScore'},last:{$max:'$practiceDate'}}},
    {$addFields:{average:{$round:[{$divide:['$total','$attempts']},1]},averagePoints:{$round:[{$divide:['$scoreTotal','$attempts']},1]},averageMaxScore:{$cond:[{$eq:[{$size:'$scales'},1]},{$arrayElemAt:['$scales',0]},null]}}},
    {$sort:rankByBest?{best:-1,bestPoints:-1,attempts:-1,average:-1}:{average:-1,attempts:-1}},...(req.query.limit?[{$limit:Math.floor(Math.min(100,Math.max(1,Number(req.query.limit)||5)))}]:[]),
    {$lookup:{from:'students',localField:'_id',foreignField:'_id',as:'student'}},{$unwind:'$student'},
    {$project:{student:{_id:'$student._id',fullName:'$student.fullName',studentId:'$student.studentId',batch:'$student.batch',photoUrl:'$student.photoUrl'},attempts:1,average:1,averagePoints:1,averageMaxScore:1,best:1,bestPoints:1,bestMaxScore:1,last:1}}
  ]);
  res.json(rows.map((row,index)=>({...row,rank:index+1,points:Math.round(row.average*row.attempts)})));
}catch(e){fail(res,e);}});

app.get('/api/competitions',auth,async(req,res)=>{try{res.json(await Competition.find().sort({startDate:-1}).lean());}catch(e){fail(res,e);}});
app.post('/api/competitions',auth,roles('coordinator'),async(req,res)=>{try{res.status(201).json(await Competition.create({...req.body,createdBy:req.user.id}));}catch(e){fail(res,e);}});
app.post('/api/competitions/:id/propose',auth,roles('coordinator'),async(req,res)=>{try{const competition=await Competition.findById(req.params.id);if(!competition)return res.sendStatus(404);const rows=await PracticeRecord.aggregate([{$match:{status:'Published',practiceDate:{$gte:competition.startDate,$lte:competition.endDate}}},{$group:{_id:'$student',average:{$avg:'$percentage'},attempts:{$sum:1}}},{$sort:{average:-1,attempts:-1}},{$limit:1},{$lookup:{from:'students',localField:'_id',foreignField:'_id',as:'student'}},{$unwind:'$student'}]);if(!rows.length)return res.status(409).json({error:'No published records in this competition'});const winner=rows[0];const approval=await WinnerApproval.create({competition:competition._id,candidate:winner._id,score:Number(winner.average.toFixed(2)),attempts:winner.attempts,proposedBy:req.user.id,status:'Pending'});res.status(201).json({approval,winner:winner.student});}catch(e){fail(res,e);}});
app.patch('/api/approvals/:id',auth,roles('faculty'),async(req,res)=>{try{if(!['Approved','Rejected'].includes(req.body.status))return res.status(400).json({error:'Status must be Approved or Rejected'});const approval=await WinnerApproval.findById(req.params.id);if(!approval)return res.sendStatus(404);if(approval.status!=='Pending')return res.status(409).json({error:'This proposal has already been reviewed'});approval.status=req.body.status;approval.reviewedBy=req.user.id;approval.reviewedAt=new Date();approval.remarks=String(req.body.remarks||'').slice(0,1000);await approval.save();if(approval.status==='Approved'){const comp=await Competition.findById(approval.competition);comp.officialWinner=approval.candidate;comp.announcementPublished=true;comp.approvedAt=approval.reviewedAt;await comp.save();}res.json(approval);}catch(e){fail(res,e);}});
app.get('/api/reports/summary',auth,roles('coordinator','faculty'),async(req,res)=>{try{const match={...recordQuery};if(req.query.start&&req.query.end)match.practiceDate=getWeek(req.query.start,req.query.end);const [students,records,attempts,modules]=await Promise.all([Student.countDocuments({enrollmentStatus:'Active'}),PracticeRecord.countDocuments(match),PracticeRecord.aggregate([{$match:match},{$group:{_id:null,average:{$avg:'$percentage'},count:{$sum:1}}}]),PracticeRecord.aggregate([{$match:match},{$group:{_id:'$module',average:{$avg:'$percentage'},attempts:{$sum:1}}}])]);res.json({activeStudents:students,publishedRecords:records,averageScore:attempts[0]?.average||0,attempts:attempts[0]?.count||0,modules});}catch(e){fail(res,e);}});
app.get('/api/reports/export.csv',auth,roles('coordinator','faculty'),async(req,res)=>{try{const rows=await PracticeRecord.find({...recordQuery,...(req.query.start&&req.query.end?{practiceDate:getWeek(req.query.start,req.query.end)}:{})}).populate('student','fullName studentId').sort({practiceDate:-1}).limit(10000).lean();const csv=['studentId,student,module,date,score,maxScore,percentage,attemptStatus',...rows.map(r=>[r.student?.studentId,r.student?.fullName,r.module,new Date(r.practiceDate).toISOString(),r.score,r.maxScore,r.percentage,r.status].map(csvCell).join(','))].join('\r\n');res.type('text/csv').attachment('practicehub-report.csv').send(csv);}catch(e){fail(res,e);}});

app.use((error, _req, res, _next) => {
  if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    const profile = error.field === 'profilePicture';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? (profile ? 'Profile picture must be 5 MB or smaller' : 'Screenshot must be 10 MB or smaller') : 'Upload one PNG, JPG, WebP, or PDF screenshot' });
  }
  console.error(error);
  return res.status(500).json({ error: 'Unable to complete request' });
});

function escapeRegex(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function csvCell(v){return `"${String(v??'').replaceAll('"','""')}"`;}
async function start(){if(!process.env.MONGODB_URI){console.error('MONGODB_URI is required. Copy .env.example to .env and configure credentials.');process.exit(1);}if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD||String(process.env.ADMIN_PASSWORD).length<12){console.error('ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters are required.');process.exit(1);}await mongoose.connect(process.env.MONGODB_URI);const email=String(process.env.ADMIN_EMAIL).trim().toLowerCase();const passwordHash=await bcrypt.hash(String(process.env.ADMIN_PASSWORD),12);await User.findOneAndUpdate({email},{$set:{name:process.env.ADMIN_NAME||'PracticeHub Admin',passwordHash,role:'coordinator',active:true}},{upsert:true,new:true,setDefaultsOnInsert:true});leaderboardSockets=webSocketServer;httpServer.listen(port,()=>console.log(`PracticeHub API listening on ${port}`));}
if(process.env.NODE_ENV!=='test')start().catch(e=>{console.error('Database connection failed:',e.message);process.exit(1);});
