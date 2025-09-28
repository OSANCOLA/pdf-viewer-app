PARTE 1 de 7

    1 const express = require('express');
    2 const session = require('express-session');
    3 const MongoStore = require('connect-mongo');
    4 const multer = require('multer');
    5 const { GridFsStorage } = require('multer-gridfs-storage');
    6 const path = require('path');
    7 const { v4: uuidv4 } = require('uuid');
    8 const sgMail = require('@sendgrid/mail');
    9 const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
   10 
   11 // --- Config ---
   12 const port = process.env.PORT || 3000;
   13 sgMail.setApiKey(process.env.SENDGRID_API_KEY);
   14 
   15 const MONGODB_URI = process.env.MONGODB_URI ||
      'mongodb+srv://oscarcornejoeo_db_user:OYMnp4ZBmVao3pEg@cluster0.23zn79g.mongodb.net/pdf-viewer-db';
   16 const DB_NAME = 'pdf-viewer-db';
   17 
   18 const app = express();
    1 // --- Main Server Function ---
    2 async function startServer() {
    3     let db, documentsCollection, permissionsCollection, loginTokensCollection, bucket;
    4     let client;
    5 
    6     try {
    7         // 1. Connect to Database
    8         client = new MongoClient(MONGODB_URI);
    9         await client.connect();
   10         db = client.db(DB_NAME);
   11         documentsCollection = db.collection('documents');
   12         permissionsCollection = db.collection('permissions');
   13         loginTokensCollection = db.collection('loginTokens');
   14         bucket = new GridFSBucket(db, { bucketName: 'pdfs' });
   15         console.log('Successfully connected to MongoDB Atlas and GridFS.');
   16 
   17         // 2. Setup Middleware
   18         app.use(express.urlencoded({ extended: true }));
   19         app.use(express.json());
   20 
   21         // 3. Setup Session Middleware
   22         app.use(session({
   23             store: MongoStore.create({
   24                 mongoUrl: MONGODB_URI,
   25                 dbName: DB_NAME,
   26                 collectionName: 'sessions',
   27                 stringify: false,
   28             }),
   29             secret: process.env.SESSION_SECRET || 'a-much-better-secret-key-for-dev',
   30             resave: false,
   31             saveUninitialized: false,
   32             cookie: {
   33                 secure: process.env.NODE_ENV === 'production',
   34                 maxAge: 1000 * 60 * 60 * 24,
   35                 httpOnly: true
   36             }
   37         }));
   38 
   39         // DEBUGGING MIDDLEWARE: Log session state on every request
   40         app.use((req, res, next) => {
   41             console.log(`--> Request for: ${req.method} ${req.url}`);
   42             if (req.session) {
   43                 console.log(`--> Session ID: ${req.session.id}`);
   44                 console.log(`--> Session Email: ${req.session.email}`);
   45             } else {
   46                 console.log('--> Session object is UNDEFINED');
   47             }
   48             next();
   49         });
   50 
   51         // 4. Setup Static Routes
   52         app.use(express.static(path.join(__dirname, 'views')));
     1         // 5. Define All Application Routes
     2 
     3         // --- Auth Middleware ---
     4         const requireLogin = (req, res, next) => {
     5             if (req.session && req.session.email) {
     6                 return next();
     7             } else {
     8                 return res.redirect('/login.html');
     9             }
    10         };
    11 
    12         // --- Admin Routes ---
    13         app.get('/permissions', requireLogin, (req, res) => {
    14             res.sendFile(path.join(__dirname, 'views', 'permissions.html'));
    15         });
    16 
    17         app.get('/api/data', requireLogin, async (req, res) => {
    18             try {
    19                 const documents = await documentsCollection.find().toArray();
    20                 const permissions = await permissionsCollection.find().toArray();
    21                 res.json({ documents, permissions });
    22             } catch (error) {
    23                 console.error('Error fetching API data:', error);
    24                 res.status(500).json({ error: 'Failed to fetch data' });
    25             }
    26         });
    27 
    28         const storage = new GridFsStorage({
    29             url: MONGODB_URI,
    30             options: { dbName: DB_NAME },
    31             file: (req, file) => {
    32                 return new Promise((resolve, reject) => {
    33                     const docId = uuidv4();
    34                     const filename = `${docId}.pdf`;
    35                     const fileInfo = {
    36                         filename: filename,
    37                         bucketName: 'pdfs',
    38                         metadata: {
    39                             originalName: file.originalname,
    40                             docId: docId
    41                         }
    42                     };
    43                     resolve(fileInfo);
    44                 });
    45             }
    46         });
    47 
    48         const upload = multer({
    49             storage: storage,
    50             limits: {
    51                 fileSize: 50 * 1024 * 1024 // 50MB limit
    52             },
    53             fileFilter: (req, file, cb) => {
    54                 if (file.mimetype === 'application/pdf') {
    55                     cb(null, true);
    56                 } else {
    57                     cb(new Error('Only PDF files are allowed'));
    58                 }
    59             }
    60         });
    61 
    62         app.post('/upload', requireLogin, upload.single('pdfFile'), async (req, res) => {
    63             try {
    64                 if (req.file) {
    65                     const docInfo = {
    66                         id: req.file.metadata.docId,
    67                         originalName: req.file.metadata.originalName,
    68                         storedName: req.file.filename,
    69                         fileId: req.file.id // GridFS file ID
    70                     };
    71                     await documentsCollection.insertOne(docInfo);
    72                     console.log('Document uploaded successfully:', docInfo);
    73                 }
    74                 res.redirect('/permissions.html');
    75             } catch (error) {
    76                 console.error('Error uploading file:', error);
    77                 res.status(500).send('Error saving document information.');
    78             }
    79         });
    80 
    81         app.post('/grant-access', requireLogin, async (req, res) => {
    82             try {
    83                 const { email, documentId } = req.body;
    84                 if (email && documentId) {
    85                     const existingPermission = await permissionsCollection.findOne({
    86                         email: email.toLowerCase(),
    87                         documentId
    88                     });
    89                     if (!existingPermission) {
    90                         await permissionsCollection.insertOne({
    91                             email: email.toLowerCase(),
    92                             documentId
    93                         });
    94                         console.log(`Access granted for ${email} to document ${documentId}`);
    95                     }
    96                 }
    97                 res.redirect('/permissions.html');
    98             } catch (error) {
    99                 console.error('Error granting access:', error);
   100                 res.status(500).send('Error granting access.');
   101             }
   102         });
    1         // --- Auth Routes ---
    2         app.post('/request-login', async (req, res) => {
    3             const { email } = req.body;
    4             if (!email) return res.status(400).send('Email is required.');
    5 
    6             const normalizedEmail = email.toLowerCase().trim();
    7             const token = Math.floor(100000 + Math.random() * 900000).toString();
    8             const newToken = {
    9                 email: normalizedEmail,
   10                 token,
   11                 expires: Date.now() + 300000
   12             }; // 5-min expiry
   13 
   14             try {
   15                 await loginTokensCollection.deleteMany({ email: normalizedEmail });
   16                 await loginTokensCollection.insertOne(newToken);
   17 
   18                 const msg = {
   19                     to: normalizedEmail,
   20                     from: 'oscarcornejo.eo@gmail.com',
   21                     subject: 'Your PDF Viewer Login Code',
   22                     text: `Your login code is: ${token}`,
   23                     html: `<p>Your login code is: <strong>${token}</strong></p><p>This code will expire
      in 5 minutes.</p>`
   24                 };
   25 
   26                 await sgMail.send(msg);
   27                 console.log('Login email sent to ' + normalizedEmail);
   28                 res.redirect(`/verify.html?email=${encodeURIComponent(normalizedEmail)}`);
   29             } catch (error) {
   30                 console.error('Error sending email:', error.response ? error.response.body : error);
   31                 res.status(500).send('Error sending login code. Please check if the email is valid.');
   32             }
   33         });
   34 
   35         app.post('/verify', async (req, res) => {
   36             try {
   37                 const { email, token } = req.body;
   38                 const normalizedEmail = email.toLowerCase().trim();
   39 
   40                 const storedToken = await loginTokensCollection.findOne({
   41                     email: normalizedEmail,
   42                     token: token.toString()
   43                 });
   44 
   45                 if (storedToken && storedToken.expires > Date.now()) {
   46                     req.session.email = normalizedEmail;
   47                     await loginTokensCollection.deleteOne({ _id: storedToken._id });
   48                     console.log('User verified:', normalizedEmail);
   49                     res.redirect('/dashboard.html');
   50                 } else {
   51                     if (storedToken) {
   52                         await loginTokensCollection.deleteOne({ _id: storedToken._id });
   53                     }
   54                     res.status(400).send('Invalid or expired token. <a href="/login.html">Try 
      again</a>');
   55                 }
   56             } catch (error) {
   57                 console.error('Error verifying token:', error);
   58                 res.status(500).send('Error during verification.');
   59             }
   60         });
   61 
   62         app.get('/logout', (req, res) => {
   63             req.session.destroy(() => res.redirect('/login.html'));
   64         });

  ---

  PARTE 5 de 7

    1         // --- User Routes ---
    2         app.get('/dashboard', requireLogin, (req, res) => {
    3             res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
    4         });
    5 
    6         app.get('/api/dashboard', requireLogin, async (req, res) => {
    7             try {
    8                 const userEmail = req.session.email.toLowerCase();
    9                 const userPermissions = await permissionsCollection.find({ email: userEmail }).toArray
      ();
   10                 const documentIds = userPermissions.map(p => p.documentId);
   11 
   12                 if (documentIds.length === 0) {
   13                     return res.json([]);
   14                 }
   15 
   16                 const userDocs = await documentsCollection.find({ id: { $in: documentIds } }).toArray
      ();
   17                 res.json(userDocs);
   18             } catch (error) {
   19                 console.error('Error in /api/dashboard:', error);
   20                 res.status(500).json({ error: 'Failed to load documents' });
   21             }
   22         });
   23 
   24         app.get('/viewer.html', requireLogin, (req, res) => {
   25             res.sendFile(path.join(__dirname, 'views', 'viewer.html'));
   26         });
    1         app.get('/pdf-data/:docId', requireLogin, async (req, res) => {
    2             try {
    3                 const { docId } = req.params;
    4                 const userEmail = req.session.email.toLowerCase();
    5 
    6                 const hasPermission = await permissionsCollection.findOne({
    7                     email: userEmail,
    8                     documentId: docId
    9                 });
   10 
   11                 if (!hasPermission) {
   12                     return res.status(403).send('Access Denied.');
   13                 }
   14 
   15                 const doc = await documentsCollection.findOne({ id: docId });
   16                 if (!doc || !doc.fileId) {
   17                     return res.status(404).send('Document not found.');
   18                 }
   19 
   20                 const files = await bucket.find({ _id: new ObjectId(doc.fileId) }).toArray();
   21                 if (!files || files.length === 0) {
   22                     return res.status(404).send('Document file is missing.');
   23                 }
   24 
   25                 res.setHeader('Content-Type', 'application/pdf');
   26                 res.setHeader('Content-Disposition', 'inline');
   27                 res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
   28 
   29                 const downloadStream = bucket.openDownloadStream(new ObjectId(doc.fileId));
   30                 downloadStream.pipe(res);
   31 
   32                 downloadStream.on('error', (error) => {
   33                     console.error('Error streaming PDF from GridFS:', error);
   34                     res.status(500).send('Error streaming document.');
   35                 });
   36 
   37             } catch (error) {
   38                 console.error('Error fetching PDF data:', error);
   39                 res.status(500).send('Error fetching document.');
   40             }
   41         });
    1         // --- Root & Error Handling ---\
    2         app.get('/', (req, res) => res.redirect('/login.html'));
    3 
    4         app.use((err, req, res, next) => {
    5             console.error('Unhandled error:', err);
    6             res.status(500).send('Something went wrong!');
    7         });
    8 
    9         app.use((req, res) => {
   10             res.status(404).send('Page not found');
   11         });
   12 
   13         // 6. Start Listening
   14         app.listen(port, () => {
   15             console.log(`Server running on port ${port}`);
   16             console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
   17         });
   18 
   19     } catch (error) {
   20         console.error('Failed to start server:', error);
   21         process.exit(1);
   22     }
   23 }
   24 
   25 // Graceful shutdown
   26 process.on('SIGTERM', async () => {
   27     console.log('SIGTERM received, shutting down gracefully');
   28     process.exit(0);
   29 });
   30 
   31 // --- Start the application ---
   32 startServer();