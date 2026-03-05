const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const cors = require('cors');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const pino = require('pino').pino({ level: 'silent' }); // Silencia logs muito verbosos
const multer = require('multer') // lib envio de aquivos
const app = express();
app.use(cors({
    origin: [
        'http://localhost:3001', // Para testes locais
        'https://ctzbuilder.onrender.com/', // Coloque a URL do seu frontend
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

let sock = null;
let qrCodeData = null;

// Cache para mensagens
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 }); // variavel global

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') { //aceitando apenas pdfs
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos PDF são permitidos!'), false);
        }
    }
});

async function connectWhatsApp() {
    try {
        // Buscar última versão disponível
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 Usando WA v${version.join('.')}, latest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Chrome', 'Linux', '20.0.04'], // Browser mais comum
            syncFullHistory: false,
            defaultQueryTimeoutMs: 120000, // Aumentar timeout
            keepAliveIntervalMs: 15000,
            msgRetryCounterCache,
            
            // Headers personalizados para evitar bloqueio
            fetchAgent: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://web.whatsapp.com',
                'Referer': 'https://web.whatsapp.com/'
            },
            
            // Configurações de rede
            connectTimeoutMs: 60000,
            maxRetries: 5,
            
            logger: pino // Reduz logs
        });

        // Evento de conexão
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update; // estabelece conecao, verefica a ultima session e gera qrcode
            if (qr) { // se tem valor passa
                qrCodeData = qr;
                try {
                    const qrcode = require('qrcode-terminal'); // gera qrcode no terminal
                    qrcode.generate(qr, { small: true });
                } catch (err) {
                }
            }

            if (connection === 'open') { // verefica instancia de conexao
                qrCodeData = null;
            }

            if (connection === 'close') { // verefica se fechou conexao
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    setTimeout(connectWhatsApp, 3000);
                } else {
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        setTimeout(connectWhatsApp, 10000);
    }
}

app.post('/send-pdf', upload.single('file'), async (req, res) => {
    try {
        console.log('Requisição recebida para enviar PDF');
        console.log('Body:', req.body);
        console.log('File:', req.file ? {
            originalname: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype
        } : 'Nenhum arquivo');

        const { number, caption } = req.body;
        
        // Validações básicas
        if (!sock?.user) {
            console.log('WhatsApp não conectado');
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        if (!req.file) {
            console.log('Nenhum arquivo enviado');
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        if (!number) {
            console.log('Número não fornecido');
            return res.status(400).json({ error: 'Número do WhatsApp não fornecido' });
        }

        // Formatar número
        let cleanNumber = number.replace(/\D/g, '');
        console.log('Número original:', number);
        console.log('Número limpo:', cleanNumber);
        
        // Adicionar código do país se necessário (55 para Brasil)
        if (cleanNumber.length === 11) {
            // Número com DDD + 9 dígitos (ex: 11999999999)
            cleanNumber = cleanNumber;
            console.log('Número formato celular com DDD:', cleanNumber);
        } else if (cleanNumber.length === 10) {
            // Número com DDD + 8 dígitos (antigo)
            cleanNumber = cleanNumber;
            console.log('Número formato fixo:', cleanNumber);
        } else if (cleanNumber.length === 13 && cleanNumber.startsWith('55')) {
            // Já tem código do país
            cleanNumber = cleanNumber;
            console.log(' Número já com código do país:', cleanNumber);
        } else {
            // Adicionar 55 se não tiver
            cleanNumber = `55${cleanNumber}`;
            console.log('Número com código do país adicionado:', cleanNumber);
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        console.log('📱 JID:', jid);
        
        try {
            // Verificar se o número existe no WhatsApp
            console.log(' Verificando se número existe no WhatsApp...');
            const [result] = await sock.onWhatsApp(cleanNumber);
            console.log(' Resultado da verificação:', result);
            
            if (!result?.exists) {
                console.log('❌ Número não tem WhatsApp:', cleanNumber);
                return res.status(400).json({ error: 'Número não tem WhatsApp' });
            }
            console.log('✅ Número verificado com sucesso');
        } catch (waError) {
            console.error('❌ Erro ao verificar número no WhatsApp:', waError);
            // Continua mesmo se falhar a verificação
        }

        // Preparar o arquivo
        const fileName = req.file.originalname || 'recibo.pdf';
        console.log(' Enviando arquivo:', fileName);
        console.log(' Tamanho:', req.file.size, 'bytes');
        console.log('Legenda:', caption || '(sem legenda)');

        // Enviar o PDF
        try {
            await sock.sendMessage(jid, {
                document: req.file.buffer,
                mimetype: 'application/pdf',
                fileName: fileName,
                caption: caption || '📄 Recibo de serviço'
            });
            console.log('PDF enviado com sucesso!');
        } catch (sendError) {
            console.error('Erro ao enviar mensagem:', sendError);
            throw sendError;
        }

        res.json({ 
            success: true, 
            message: 'PDF enviado com sucesso!',
            fileName: fileName,
            size: req.file.size,
            number: cleanNumber
        });
        
    } catch (error) {
        console.error('Erro ao enviar PDF:', error);
        console.error('Stack trace:', error.stack);
        
        // Mensagens de erro mais específicas
        let errorMessage = 'Erro interno do servidor';
        if (error.message.includes('socket')) {
            errorMessage = 'Conexão com WhatsApp perdida';
        } else if (error.message.includes('buffer')) {
            errorMessage = 'Erro ao processar arquivo PDF';
        } else if (error.message.includes('jid')) {
            errorMessage = 'Formato de número inválido';
        } else {
            errorMessage = error.message;
        }
        
        res.status(500).json({ 
            error: errorMessage,
            details: error.message
        });
    }
});

app.get('/status', (req, res) => {
    res.json({
        connected: sock?.user ? true : false,
        user: sock?.user || null,
        hasQR: !!qrCodeData,
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.json({ qr: qrCodeData });
    } else {
        res.json({ qr: null, message: 'QR não disponível' });
    }
});

app.post('/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!sock?.user) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        let cleanNumber = number.replace(/\D/g, '');
        
        // Formatar número (Brasil)
        if (cleanNumber.length === 11) {
            console.log('aqui passou')
            cleanNumber = `55${cleanNumber}`;
        } else if (cleanNumber.length === 10) {
            console.error('erro aqui')
            cleanNumber = `55${cleanNumber}`;
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        
        const [result] = await sock.onWhatsApp(cleanNumber);
        
        if (!result?.exists) {
            return res.status(400).json({ error: 'Número não tem WhatsApp' });
        }

        await sock.sendMessage(jid, { text: message });
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ error: error.message });
    }
});


connectWhatsApp(); // chamando action

// const PORT = 3001;
// app.listen(PORT, () => {
//     console.log(`🚀 Servidor: http://localhost:${PORT}`);
// });
 // prod
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});