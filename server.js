const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sgMail = require('@sendgrid/mail');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');

// --- Config ---
const port = process.env.PORT || 3000;
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oscarcornejoeo_db_user:OYMnp4ZBmVao3pEg@cluster0.23zn79g.mongodb.net/pdf-viewer-db';
const DB_NAME = 'pdf-viewer-db';

const app = express();

// --- Main Server Function ---
async function startServer() {
    let db, documentsCollection, permissionsCollection, loginTokensCollection, bucket;
    let client;

    try {
        // 1. Connect to Database
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);
        documentsCollection = db.collection('documents');
        permissionsCollection = db.collection('permissions');
        loginTokensCollection = db.collection('loginTokens');
        bucket = new GridFSBucket(db, { bucketName: 'pdfs' });
        console.log('Successfully connected to MongoDB Atlas and GridFS.');

        // 2. Setup Middleware
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json());

        // 3. Setup Session Middleware
        app.use(session({
            store: MongoStore.create({
                mongoUrl: MONGODB_URI,
                dbName: DB_NAME,
                collectionName: 'sessions',
                stringify: false,
            }),
            secret: process.env.SESSION_SECRET || 'a-much-better-secret-key-for-dev',
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: process.env.NODE_ENV === 'production',
                maxAge: 1000 * 60 * 60 * 24,
                httpOnly: true
            }
        }));

        // DEBUGGING MIDDLEWARE: Log session state on every request
        app.use((req, res, next) => {
            console.log(`--> Request for: ${req.method} ${req.url}`)
            if (req.session) {
                console.log(`--> Session ID: ${req.session.id}`);
                console.log(`--> Session Email: ${req.session.email}`);
            } else {
                console.log('--> Session object is UNDEFINED');
            }
            next();
        });

        // 4. Setup Static Routes
        app.use(express.static(path.join(__dirname, 'views')));

        // 5. Define All Application Routes

        // --- Auth Middleware ---
        const requireLogin = (req, res, next) => {
            if (req.session && req.session.email) {
                return next();
            } else {
                return res.redirect('/login.html');
            }
        };

        // --- Admin Routes ---
        app.get('/permissions', requireLogin, (req, res) => {
            res.sendFile(path.join(__dirname, 'views', 'permissions.html'));
        });

        app.get('/api/data', requireLogin, async (req, res) => {
            try {
                const documents = await documentsCollection.find().toArray();
                const permissions = await permissionsCollection.find().toArray();
                res.json({ documents, permissions });
            } catch (error) {
                console.error('Error fetching API data:', error);
                res.status(500).json({ error: 'Failed to fetch data' });
            }
        });

        const storage = new GridFsStorage({
            url: MONGODB_URI,
            options: { dbName: DB_NAME },
            file: (req, file) => {
                return new Promise((resolve, reject) => {
                    const docId = uuidv4();
                    const filename = `${docId}.pdf`;
                    const fileInfo = {
                        filename: filename,
                        bucketName: 'pdfs',
                        metadata: {
                            originalName: file.originalname,
                            docId: docId
                        }
                    };
                    resolve(fileInfo);
                });
            }
        });

        const upload = multer({
            storage: storage,
            limits: {
                fileSize: 50 * 1024 * 1024 // 50MB limit
            },
            fileFilter: (req, file, cb) => {
                if (file.mimetype === 'application/pdf') {
                    cb(null, true);
                } else {
                    cb(new Error('Only PDF files are allowed'));
                }
            }
        });

        app.post('/upload', requireLogin, upload.single('pdfFile'), async (req, res) => {
            try {
                if (req.file) {
                    const docInfo = {
                        id: req.file.metadata.docId,
                        originalName: req.file.metadata.originalName,
                        storedName: req.file.filename,
                        fileId: req.file.id // GridFS file ID
                    };
                    await documentsCollection.insertOne(docInfo);
                    console.log('Document uploaded successfully:', docInfo);
                }
                res.redirect('/permissions.html');
            } catch (error) {
                console.error('Error uploading file:', error);
                res.status(500).send('Error saving document information.');
            }
        });

        app.post('/grant-access', requireLogin, async (req, res) => {
            try {
                const { email, documentId } = req.body;
                if (email && documentId) {
                    const existingPermission = await permissionsCollection.findOne({
                        email: email.toLowerCase(),
                        documentId
                    });
                    if (!existingPermission) {
                        await permissionsCollection.insertOne({
                            email: email.toLowerCase(),
                            documentId
                        });
                        console.log(`Access granted for ${email} to document ${documentId}`);
                    }
                }
                res.redirect('/permissions.html');
            } catch (error) {
                console.error('Error granting access:', error);
                res.status(500).send('Error granting access.');
            }
        });

        // --- Auth Routes ---
        app.post('/request-login', async (req, res) => {
            const { email } = req.body;
            if (!email) return res.status(400).send('Email is required.');

            const normalizedEmail = email.toLowerCase().trim();
            const token = Math.floor(100000 + Math.random() * 900000).toString();
            const newToken = {
                email: normalizedEmail,
                token,
                expires: Date.now() + 300000
            }; // 5-min expiry

            try {
                await loginTokensCollection.deleteMany({ email: normalizedEmail });
                await loginTokensCollection.insertOne(newToken);

                const msg = {
                    to: normalizedEmail,
                    from: 'oscarcornejo.eo@gmail.com',
                    subject: 'Your PDF Viewer Login Code',
                    text: `Your login code is: ${token}`,
                    html: `<p>Your login code is: <strong>${token}</strong></p><p>This code will expire in 5 minutes.</p>`
                };

                await sgMail.send(msg);
                console.log('Login email sent to ' + normalizedEmail);
                res.redirect(`/verify.html?email=${encodeURIComponent(normalizedEmail)}`);
            } catch (error) {
                console.error('Error sending email:', error.response ? error.response.body : error);
                res.status(500).send('Error sending login code. Please check if the email is valid.');
            }
        });

        app.post('/verify', async (req, res) => {
            try {
                const { email, token } = req.body;
                const normalizedEmail = email.toLowerCase().trim();

                const storedToken = await loginTokensCollection.findOne({
                    email: normalizedEmail,
                    token: token.toString()
                });

                                if (storedToken && storedToken.expires > Date.now()) {
                    req.session.email = normalizedEmail;
                    await loginTokensCollection.deleteOne({ _id: storedToken._id });

                    req.session.save((err) => {
                        if (err) {
                            console.error('Error saving session:', err);
                            return res.status(500).send('Error saving session.');
                        }
                        console.log('User verified and session saved:', normalizedEmail);
                        res.redirect('/dashboard.html');
                    });
                } else {
                    if (storedToken) {
                        await loginTokensCollection.deleteOne({ _id: storedToken._id });
                    }
                    res.status(400).send('Invalid or expired token. <a href="/login.html">Try again</a>');
                }
            } catch (error) {
                console.error('Error verifying token:', error);
                res.status(500).send('Error during verification.');
            }
        });

        app.get('/logout', (req, res) => {
            req.session.destroy(() => res.redirect('/login.html'));
        });

        // --- User Routes ---
        app.get('/dashboard', requireLogin, (req, res) => {
            res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
        });

        app.get('/api/dashboard', requireLogin, async (req, res) => {
            try {
                const userEmail = req.session.email.toLowerCase();
                const userPermissions = await permissionsCollection.find({ email: userEmail }).toArray();
                const documentIds = userPermissions.map(p => p.documentId);

                if (documentIds.length === 0) {
                    return res.json([]);
                }

                const userDocs = await documentsCollection.find({ id: { $in: documentIds } }).toArray();
                res.json(userDocs);
            } catch (error) {
                console.error('Error in /api/dashboard:', error);
                res.status(500).json({ error: 'Failed to load documents' });
            }
        });

        app.get('/viewer.html', requireLogin, (req, res) => {
            res.sendFile(path.join(__dirname, 'views', 'viewer.html'));
        });

        app.get('/pdf-data/:docId', requireLogin, async (req, res) => {
            try {
                const { docId } = req.params;
                const userEmail = req.session.email.toLowerCase();

                const hasPermission = await permissionsCollection.findOne({
                    email: userEmail,
                    documentId: docId
                });

                if (!hasPermission) {
                    return res.status(403).send('Access Denied.');
                }

                const doc = await documentsCollection.findOne({ id: docId });
                if (!doc || !doc.fileId) {
                    return res.status(404).send('Document not found.');
                }

                const files = await bucket.find({ _id: new ObjectId(doc.fileId) }).toArray();
                if (!files || files.length === 0) {
                    return res.status(404).send('Document file is missing.');
                }

                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', 'inline');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

                const downloadStream = bucket.openDownloadStream(new ObjectId(doc.fileId));
                downloadStream.pipe(res);

                downloadStream.on('error', (error) => {
                    console.error('Error streaming PDF from GridFS:', error);
                    res.status(500).send('Error streaming document.');
                });

            } catch (error) {
                console.error('Error fetching PDF data:', error);
                res.status(500).send('Error fetching document.');
            }
        });

        // --- Root & Error Handling ---
        app.get('/', (req, res) => res.redirect('/login.html'));

        app.use((err, req, res, next) => {
            console.error('Unhandled error:', err);
            res.status(500).send('Something went wrong!');
        });

        app.use((req, res) => {
            res.status(404).send('Page not found');
        });

        // 6. Start Listening
        app.listen(port, () => {
            console.log(`Server running on port ${port}`);
            console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

// --- Start the application ---
startServer();
