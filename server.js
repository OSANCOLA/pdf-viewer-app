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
    19 
    20 // --- Main Server Function ---
    21 async function startServer() {
    22     let db, documentsCollection, permissionsCollection, loginTokensCollection, bucket;
    23     let client;
    24 
    25     try {
    26         // 1. Connect to Database
    27         client = new MongoClient(MONGODB_URI);
    28         await client.connect();
    29         db = client.db(DB_NAME);
    30         documentsCollection = db.collection('documents');
    31         permissionsCollection = db.collection('permissions');
    32         loginTokensCollection = db.collection('loginTokens');
    33         bucket = new GridFSBucket(db, { bucketName: 'pdfs' });
    34         console.log('Successfully connected to MongoDB Atlas and GridFS.');
    35 
    36         // 2. Setup Middleware
    37         app.use(express.urlencoded({ extended: true }));
    38         app.use(express.json());
    39 
    40         // 3. Setup Session Middleware (CRITICAL: Must be after DB connection and before routes)
    41         app.use(session({
    42             store: MongoStore.create({
    43                                 mongoUrl: MONGODB_URI,
    44                 dbName: DB_NAME,
    45                 collectionName: 'sessions',
    46                 stringify: false,
    47             }),
    48             secret: process.env.SESSION_SECRET || 'a-much-better-secret-key-for-dev',
    49             resave: false,
    50             saveUninitialized: false,
    51             cookie: {
    52                 secure: process.env.NODE_ENV === 'production',
    53                 maxAge: 1000 * 60 * 60 * 24,
    54                 httpOnly: true
    55             }
    56         }));
    57 
    58         // 4. Setup Static Routes
    59         app.use(express.static(path.join(__dirname, 'views')));
    60 
    61         // 5. Define All Application Routes
    62 
    63         // --- Auth Middleware ---
    64         const requireLogin = (req, res, next) => {
    65             if (req.session && req.session.email) {
    66                 return next();
    67             } else {
    68                 return res.redirect('/login.html');
    69             }
    70         };
    71 
    72         // --- Admin Routes ---
    73         app.get('/permissions', requireLogin, (req, res) => {
    74             res.sendFile(path.join(__dirname, 'views', 'permissions.html'));
    75         });
    76 
    77         app.get('/api/data', requireLogin, async (req, res) => {
    78             try {
    79                 const documents = await documentsCollection.find().toArray();
    80                 const permissions = await permissionsCollection.find().toArray();
    81                 res.json({ documents, permissions });
    82             } catch (error) {
    83                 console.error('Error fetching API data:', error);
    84                 res.status(500).json({ error: 'Failed to fetch data' });
    85             }
    86         });
    87 
    88         const storage = new GridFsStorage({
    89             url: MONGODB_URI,
    90             options: { dbName: DB_NAME },
    91             file: (req, file) => {
    92                 return new Promise((resolve, reject) => {
    93                     const docId = uuidv4();
    94                     const filename = `${docId}.pdf`;
    95                     const fileInfo = {
    96                         filename: filename,
    97                         bucketName: 'pdfs',
    98                         metadata: {
    99                             originalName: file.originalname,
   100                             docId: docId
   101                         }
   102                     };
   103                     resolve(fileInfo);
   104                 });
   105             }
   106         });
   107 
   108         const upload = multer({
   109             storage: storage,
   110             limits: {
   111                 fileSize: 50 * 1024 * 1024 // 50MB limit
   112             },
   113             fileFilter: (req, file, cb) => {
   114                 if (file.mimetype === 'application/pdf') {
   115                     cb(null, true);
   116                 } else {
   117                     cb(new Error('Only PDF files are allowed'));
   118                 }
   119             }
   120         });
   121 
   122         app.post('/upload', requireLogin, upload.single('pdfFile'), async (req, res) => {
   123             try {
   124                 if (req.file) {
   125                     const docInfo = {
   126                         id: req.file.metadata.docId,
   127                         originalName: req.file.metadata.originalName,
   128                         storedName: req.file.filename,
   129                         fileId: req.file.id // GridFS file ID
   130                     };
   131                     await documentsCollection.insertOne(docInfo);
   132                     console.log('Document uploaded successfully:', docInfo);
   133                 }
   134                 res.redirect('/permissions.html');
   135             } catch (error) {
   136                 console.error('Error uploading file:', error);
   137                 res.status(500).send('Error saving document information.');
   138             }
   139         });
   140 
   141         app.post('/grant-access', requireLogin, async (req, res) => {
   142             try {
   143                 const { email, documentId } = req.body;
   144                 if (email && documentId) {
   145                     const existingPermission = await permissionsCollection.findOne({
   146                         email: email.toLowerCase(),
   147                         documentId
   148                     });
   149                     if (!existingPermission) {
   150                         await permissionsCollection.insertOne({
   151                             email: email.toLowerCase(),
   152                             documentId
   153                         });
   154                         console.log(`Access granted for ${email} to document ${documentId}`);
   155                     }
   156                 }
   157                 res.redirect('/permissions.html');
   158             } catch (error) {
   159                 console.error('Error granting access:', error);
   160                 res.status(500).send('Error granting access.');
   161             }
   162         });

  ---

  PARTE 2

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
   65 
   66         // --- User Routes ---
   67         app.get('/dashboard', requireLogin, (req, res) => {
   68             res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
   69         });
   70 
   71         app.get('/api/dashboard', requireLogin, async (req, res) => {
   72             try {
   73                 const userEmail = req.session.email.toLowerCase();
   74                 const userPermissions = await permissionsCollection.find({ email: userEmail }).toArray
      ();
   75                 const documentIds = userPermissions.map(p => p.documentId);
   76 
   77                 if (documentIds.length === 0) {
   78                     return res.json([]);
   79                 }
   80 
   81                 const userDocs = await documentsCollection.find({ id: { $in: documentIds } }).toArray
      ();
   82                 res.json(userDocs);
   83             } catch (error) {
   84                 console.error('Error in /api/dashboard:', error);
   85                 res.status(500).json({ error: 'Failed to load documents' });
   86             }
   87         });
   88 
   89         app.get('/viewer.html', requireLogin, (req, res) => {
   90             res.sendFile(path.join(__dirname, 'views', 'viewer.html'));
   91         });

  ---

  PARTE 3

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
   42 
   43         // --- Root & Error Handling ---\
   44         app.get('/', (req, res) => res.redirect('/login.html'));
   45 
   46         app.use((err, req, res, next) => {
   47             console.error('Unhandled error:', err);
   48             res.status(500).send('Something went wrong!');
   49         });
   50 
   51         app.use((req, res) => {
   52             res.status(404).send('Page not found');
   53         });
   54 
   55         // 6. Start Listening
   56         app.listen(port, () => {
   57             console.log(`Server running on port ${port}`);
   58             console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
   59         });
   60 
   61     } catch (error) {
   62         console.error('Failed to start server:', error);
   63         process.exit(1);
   64     }
   65 }
   66 
   67 // Graceful shutdown
   68 process.on('SIGTERM', async () => {
   69     console.log('SIGTERM received, shutting down gracefully');
   70     process.exit(0);
   71 });
   72 
   73 // --- Start the application ---
   74 startServer();