const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sgMail = require('@sendgrid/mail');
const { MongoClient } = require('mongodb');

// --- Config ---
const port = process.env.PORT || 3000;
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// IMPORTANT: Store this as an environment variable in Render
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oscarcornejoeo_db_user:OYMnp4ZBmVao3pEg@cluster0.23zn79g.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME = 'pdf-viewer-db';

// --- Database Connection ---
let db, documentsCollection, permissionsCollection, loginTokensCollection;

async function connectDB() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);
        documentsCollection = db.collection('documents');
        permissionsCollection = db.collection('permissions');
        loginTokensCollection = db.collection('loginTokens');
        console.log('Successfully connected to MongoDB Atlas.');
    } catch (error) {
        console.error('Failed to connect to MongoDB Atlas.', error);
        process.exit(1); // Exit if we can't connect to the DB
    }
}

const app = express();

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    store: new FileStore({ logFn: function() {} }), // No logging
    secret: process.env.SESSION_SECRET || 'a-much-better-secret-key-for-dev',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 } // 24 hour session
}));
app.use(express.static(path.join(__dirname, 'views')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'uploads');
        fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const storedName = `${uuidv4()}.pdf`;
        const docInfo = {
            id: storedName.replace('.pdf', ''),
            originalName: file.originalname,
            storedName: storedName
        };
        // The database insertion will be handled in the route handler
        req.docInfo = docInfo;
        cb(null, storedName);
    }
});
const upload = multer({ storage: storage });

app.post('/upload', requireLogin, upload.single('pdfFile'), async (req, res) => {
    try {
        if (req.docInfo) {
            await documentsCollection.insertOne(req.docInfo);
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
            const existingPermission = await permissionsCollection.findOne({ email, documentId });
            if (!existingPermission) {
                await permissionsCollection.insertOne({ email, documentId });
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

    const token = Math.floor(100000 + Math.random() * 900000).toString();
    const newToken = { email, token, expires: Date.now() + 300000 }; // 5-min expiry

    try {
        // Remove old tokens for the same email and insert the new one
        await loginTokensCollection.deleteMany({ email });
        await loginTokensCollection.insertOne(newToken);

        const msg = {
            to: email,
            from: 'oscarcornejo.eo@gmail.com', // This should ideally be a verified sender in SendGrid
            subject: 'Your PDF Viewer Login Code',
            text: `Your login code is: ${token}`,
        };

        await sgMail.send(msg);
        console.log('Login email sent to ' + email);
        res.redirect(`/verify.html?email=${encodeURIComponent(email)}`);
    } catch (error) {
        console.error('Error sending email:', error.response ? error.response.body : error);
        res.status(500).send('Error sending login code.');
    }
});

app.post('/verify', async (req, res) => {
    try {
        const { email, token } = req.body;
        const storedToken = await loginTokensCollection.findOne({ email, token });

        if (storedToken && storedToken.expires > Date.now()) {
            req.session.email = email;
            await loginTokensCollection.deleteOne({ _id: storedToken._id });
            console.log('User verified:', email);
            res.redirect('/dashboard.html');
        } else {
            if (storedToken) { // Token expired
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
        const userPermissions = await permissionsCollection.find({ email: { $regex: new RegExp(`^${userEmail}$`, 'i') } }).toArray();
        const documentIds = userPermissions.map(p => p.documentId);
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
        const userEmail = req.session.email;

        const hasPermission = await permissionsCollection.findOne({ email: { $regex: new RegExp(`^${userEmail}$`, 'i') }, documentId: docId });
        if (!hasPermission) return res.status(403).send('Access Denied.');

        const doc = await documentsCollection.findOne({ id: docId });
        if (!doc) return res.status(404).send('Document not found.');

        const pdfPath = path.join(__dirname, 'uploads', doc.storedName);
        if (fs.existsSync(pdfPath)) {
            res.sendFile(pdfPath);
        } else {
            res.status(404).send('Document file is missing.');
        }
    } catch (error) {
        console.error('Error fetching PDF data:', error);
        res.status(500).send('Error fetching document.');
    }
});

// --- Root ---
app.get('/', (req, res) => res.redirect('/login.html'));

// --- Server ---
async function startServer() {
    await connectDB();
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

startServer();