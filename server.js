const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const cors = require('cors');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const pino = require('pino');
const multer = require('multer');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();

// Configuração do logger sem pino-pretty
const logger = pino({
    level: 'info',
    // Removido o transport que causava erro
});

// Logger mais simples para console
const log = {
    info: (...args) => console.log('[INFO]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    success: (...args) => console.log('[SUCCESS]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args)
};

app.use(cors({
    origin: [
        'http://localhost:3001',
        'https://ctzbuilder.onrender.com',
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

let sock = null;
let qrCodeData = null;
let qrCodeBase64 = null;
let connectionAttempts = 0;

// Criar diretório de autenticação se não existir
const authDir = path.join(process.cwd(), 'auth_info_baileys');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

const msgRetryCounterCache = new NodeCache({ stdTTL: 60 });

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos PDF são permitidos!'), false);
        }
    }
});

async function connectWhatsApp() {
    try {
        connectionAttempts++;
        log.info(`Tentativa de conexão #${connectionAttempts}`);
        
        const { version, isLatest } = await fetchLatestBaileysVersion();
        log.info(`📱 Usando WA v${version.join('.')}, latest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Chrome (Linux)', 'Main', '20.0.04'],
            syncFullHistory: false,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            msgRetryCounterCache,
            logger: pino({ level: 'silent' }),
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            maxRetries: 3,
            retryRequestDelayMs: 500
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCodeData = qr;
                connectionAttempts = 0; // Reset contador
                
                log.info('\n' + '='.repeat(60));
                log.info('🔐 QR CODE GERADO - Escaneie com WhatsApp');
                log.info('='.repeat(60));
                
                // Método 1: URL online (MAIS CONFIÁVEL)
                try {
                    const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qr)}&size=300x300`;
                    log.info('📱 LINK PARA ESCANEAR (copie e cole no navegador):');
                    log.info(qrUrl);
                    log.info('\nOu acesse:');
                } catch (err) {
                    log.error('Erro ao gerar URL:', err);
                }
                
                // Método 2: Base64
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr);
                    log.info('📱 Acesse a rota /qr-view no seu navegador');
                } catch (err) {
                    log.error('Erro ao gerar base64:', err);
                }
                
                // Método 3: Terminal (tentativa)
                try {
                    const qrcodeTerminal = require('qrcode-terminal');
                    console.log('\n📱 QR Code no terminal (tente escanear):\n');
                    qrcodeTerminal.generate(qr, { small: false });
                } catch (err) {
                    // Ignora erro do terminal
                }
                
                log.info('='.repeat(60) + '\n');
            }

            if (connection === 'open') {
                qrCodeData = null;
                qrCodeBase64 = null;
                connectionAttempts = 0;
                log.success('✅ WhatsApp conectado com sucesso!');
                log.success(`👤 Conectado como: ${sock.user?.name || sock.user?.id || 'Desconhecido'}`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error instanceof Boom 
                    ? lastDisconnect.error.output?.statusCode 
                    : null;
                
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const shouldReconnect = !isLoggedOut;
                
                if (isLoggedOut) {
                    log.warn('🚪 Deslogado do WhatsApp, necessário novo QR code');
                    qrCodeData = null;
                    qrCodeBase64 = null;
                    
                    // Limpar credenciais antigas
                    try {
                        fs.rmSync(authDir, { recursive: true, force: true });
                        fs.mkdirSync(authDir, { recursive: true });
                        log.info('📁 Credenciais antigas removidas');
                    } catch (err) {
                        log.error('Erro ao limpar credenciais:', err);
                    }
                } else {
                    log.warn(`❌ Conexão fechada (tentativa ${connectionAttempts})`);
                }
                
                if (shouldReconnect) {
                    const timeout = Math.min(connectionAttempts * 1000, 10000);
                    log.info(`🔄 Reconectando em ${timeout/1000} segundos...`);
                    setTimeout(connectWhatsApp, timeout);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        log.error('Erro na conexão:', error.message);
        const timeout = Math.min(connectionAttempts * 2000, 15000);
        log.info(`🔄 Tentando novamente em ${timeout/1000} segundos...`);
        setTimeout(connectWhatsApp, timeout);
    }
}

// Rota principal com HTML para visualizar QR
app.get('/', (req, res) => {
    const status = sock?.user ? 'connected' : (qrCodeData ? 'qr_ready' : 'disconnected');
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial; max-width: 800px; margin: 0 auto; padding: 20px; text-align: center; }
                .card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; }
                .connected { color: green; }
                .disconnected { color: red; }
                .qr-container { margin: 20px auto; }
                img { max-width: 100%; height: auto; border: 1px solid #ddd; }
                .button { display: inline-block; padding: 10px 20px; margin: 10px; background: #25D366; color: white; text-decoration: none; border-radius: 5px; }
                .info { color: #666; margin: 10px; }
                pre { background: #f4f4f4; padding: 10px; border-radius: 5px; text-align: left; overflow-x: auto; }
            </style>
        </head>
        <body>
            <h1>🤖 WhatsApp Bot</h1>
            
            <div class="card">
                <h2>Status: <span class="${status === 'connected' ? 'connected' : 'disconnected'}">${status}</span></h2>
                
                ${sock?.user ? `
                    <p>✅ Conectado como: <strong>${sock.user.name || sock.user.id}</strong></p>
                ` : ''}
            </div>
            
            ${qrCodeData ? `
                <div class="card">
                    <h2>📱 Escaneie o QR Code</h2>
                    <div class="qr-container">
                        <img src="/qr-image" alt="QR Code">
                    </div>
                    <div class="info">
                        <p>1. Abra o WhatsApp no seu celular</p>
                        <p>2. Toque em Menu (⋮) ou Configurações</p>
                        <p>3. Selecione "WhatsApp Web"</p>
                        <p>4. Escaneie este código</p>
                    </div>
                    <a href="${`https://quickchart.io/qr?text=${encodeURIComponent(qrCodeData)}&size=300x300`}" target="_blank" class="button">Abrir QR em nova aba</a>
                </div>
            ` : ''}
            
            <div class="card">
                <h3>📋 Endpoints da API</h3>
                <pre>
GET  /status       - Status da conexão
GET  /qr           - Dados do QR (JSON)
GET  /qr-image     - Imagem do QR
POST /send-message - Enviar mensagem
POST /send-pdf     - Enviar PDF
                </pre>
            </div>
            
            <p><small>Servidor rodando em: ${baseUrl}</small></p>
            
            <script>
                setTimeout(() => location.reload(), 30000);
            </script>
        </body>
        </html>
    `);
});

app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.json({ 
            success: true,
            qr: qrCodeData,
            qrBase64: qrCodeBase64,
            qrUrl: `https://quickchart.io/qr?text=${encodeURIComponent(qrCodeData)}&size=300x300`,
            message: 'QR Code disponível'
        });
    } else {
        res.json({ 
            success: false,
            qr: null, 
            qrBase64: null,
            message: sock?.user ? 'Já conectado' : 'QR não disponível'
        });
    }
});

app.get('/qr-image', async (req, res) => {
    if (!qrCodeData) {
        return res.status(404).send('QR Code não disponível');
    }
    
    try {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        
        const qrBuffer = await QRCode.toBuffer(qrCodeData, {
            width: 400,
            margin: 2,
            errorCorrectionLevel: 'H'
        });
        
        res.send(qrBuffer);
    } catch (error) {
        log.error('Erro ao gerar imagem QR:', error);
        res.status(500).send('Erro ao gerar imagem do QR');
    }
});

app.get('/qr-view', (req, res) => {
    res.redirect('/');
});

app.get('/status', (req, res) => {
    res.json({
        connected: sock?.user ? true : false,
        user: sock?.user ? {
            id: sock.user.id,
            name: sock.user.name || 'Desconhecido',
            devices: sock.user.devices || []
        } : null,
        hasQR: !!qrCodeData,
        attempts: connectionAttempts,
        timestamp: new Date().toISOString()
    });
});

// Endpoint para enviar PDF
app.post('/send-pdf', upload.single('file'), async (req, res) => {
    try {
        log.info('📄 Requisição para enviar PDF recebida');
        
        const { number, caption } = req.body;
        
        if (!sock?.user) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        if (!number) {
            return res.status(400).json({ error: 'Número do WhatsApp não fornecido' });
        }

        // Formatar número
        let cleanNumber = number.replace(/\D/g, '');
        
        // Adicionar código do Brasil se necessário
        if (cleanNumber.length <= 11 && !cleanNumber.startsWith('55')) {
            cleanNumber = `55${cleanNumber}`;
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        log.info(`📱 Enviando para: ${jid}`);
        
        const fileName = req.file.originalname || 'documento.pdf';
        
        await sock.sendMessage(jid, {
            document: req.file.buffer,
            mimetype: 'application/pdf',
            fileName: fileName,
            caption: caption || '📄 Documento enviado'
        });
        
        log.success(`✅ PDF enviado para ${cleanNumber}`);
        
        res.json({ 
            success: true, 
            message: 'PDF enviado com sucesso!',
            fileName: fileName,
            number: cleanNumber
        });
        
    } catch (error) {
        log.error('❌ Erro ao enviar PDF:', error);
        res.status(500).json({ 
            error: 'Erro ao enviar PDF',
            details: error.message 
        });
    }
});

// Endpoint para enviar mensagem de texto
app.post('/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!sock?.user) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        if (!number || !message) {
            return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
        }

        let cleanNumber = number.replace(/\D/g, '');
        
        if (cleanNumber.length <= 11 && !cleanNumber.startsWith('55')) {
            cleanNumber = `55${cleanNumber}`;
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text: message });
        
        res.json({ success: true, message: 'Mensagem enviada!' });
        
    } catch (error) {
        log.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ error: error.message });
    }
});

// Iniciar conexão
connectWhatsApp();

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    log.success('\n' + '='.repeat(50));
    log.success('🚀 SERVIDOR INICIADO COM SUCESSO!');
    log.success('='.repeat(50));
    log.info(`📱 Porta: ${PORT}`);
    
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    log.info(`🌐 URL: ${baseUrl}`);
    log.info('\n📌 Para escanear o QR Code:');
    log.info(`   1. Acesse: ${baseUrl}`);
    log.info(`   2. Ou acesse: ${baseUrl}/qr-view`);
    log.info('   3. Escaneie com o WhatsApp\n');
});