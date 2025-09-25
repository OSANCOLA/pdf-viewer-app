const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sgMail = require('@sendgrid/mail');

// --- Database Setup ---
const DB_PATH = path.join(__dirname, 'database.json');
let documents = [];
let permissions = [];
let loginTokens = {}; // Should be global for this single-instance approach

function loadDatabase() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = fs.readFileSync(DB_PATH, 'utf8');
            const db = JSON.parse(data);
            documents = db.documents || [];
            permissions = db.permissions || [];
            console.log('Database loaded successfully.');
        }
    } catch (error) {
        console.error('Error loading database:', error);
        documents = [];
        permissions = [];
    }
}

function saveDatabase() {
    try {
        const db = { documents, permissions };
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
        console.log('Database saved successfully.');
    } catch (error) {
        console.error('Error saving database:', error);
    }
}

// --- SendGrid Setup ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'a-much-better-secret-key-for-prod',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in prod
}));
app.use(express.static('views'));
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
app.get('/permissions', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'permissions.html'));
});

app.get('/api/data', (req, res) => {
    res.json({ documents, permissions });
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
        documents.push(docInfo);
        saveDatabase();
        cb(null, storedName);
    }
});
const upload = multer({ storage: storage });

app.post('/upload', upload.single('pdfFile'), (req, res) => {
    res.redirect('/permissions.html');
});

app.post('/grant-access', (req, res) => {
    const { email, documentId } = req.body;
    if (email && documentId && !permissions.some(p => p.email === email && p.documentId === documentId)) {
        permissions.push({ email, documentId });
        saveDatabase();
        console.log(`Access granted for ${email} to document ${documentId}`);
    }
    res.redirect('/permissions.html');
});

// --- Auth Routes ---
app.post('/request-login', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send('Email is required.');

    const token = Math.floor(100000 + Math.random() * 900000).toString();
    loginTokens[email] = { token, expires: Date.now() + 300000 }; // 5-min expiry

    const msg = {
        to: email,
        from: 'oscarcornejo.eo@gmail.com',
        subject: 'Your PDF Viewer Login Code',
        text: `Your login code is: ${token}`,
    };

    try {
        await sgMail.send(msg);
        console.log('Login email sent to ' + email);
        res.redirect(`/verify.html?email=${encodeURIComponent(email)}`);
    } catch (error) {
        console.error('Error sending email:', error.response ? error.response.body : error);
        res.status(500).send('Error sending login code.');
    }
});

app.post('/verify', (req, res) => {
    const { email, token } = req.body;
    const storedToken = loginTokens[email];

    if (storedToken && storedToken.token === token && storedToken.expires > Date.now()) {
        req.session.email = email;
        delete loginTokens[email];
        console.log('User verified:', email);
        res.redirect('/dashboard.html');
    } else {
        res.status(400).send('Invalid or expired token. <a href="/login.html">Try again</a>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// --- User Routes ---
app.get('/dashboard', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/api/dashboard', requireLogin, (req, res) => {
    const userPermissions = permissions.filter(p => p.email === req.session.email);
    const userDocs = documents.filter(doc => userPermissions.some(p => p.documentId === doc.id));
    res.json(userDocs);
});

app.get('/viewer.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'viewer.html'));
});

app.get('/pdf-data/:docId', requireLogin, (req, res) => {
    const { docId } = req.params;
    const hasPermission = permissions.some(p => p.email === req.session.email && p.documentId === docId);
    if (!hasPermission) return res.status(403).send('Access Denied.');

    const doc = documents.find(d => d.id === docId);
    if (!doc) return res.status(404).send('Document not found.');

    const pdfPath = path.join(__dirname, 'uploads', doc.storedName);
    if (fs.existsSync(pdfPath)) {
        res.sendFile(pdfPath);
    } else {
        res.status(404).send('Document file is missing.');
    }
});

// --- Root ---
app.get('/', (req, res) => res.redirect('/login.html'));

// --- Server ---
app.listen(port, () => {
    loadDatabase();
    console.log(`Server running on port ${port}`);
});
