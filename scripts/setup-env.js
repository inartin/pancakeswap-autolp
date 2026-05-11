import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Setup script to generate secure MASTER_PASSWORD for encryption
 * Run this once after cloning the project: pnpm setup
 */
function setupEnvironment() {
    const envPath = path.join(__dirname, '..', '.env');
    const envExamplePath = path.join(__dirname, '..', '.env.example');

    console.log('🔧 Setting up environment...\n');

    // Check if .env exists, if not copy from .env.example
    if (!fs.existsSync(envPath)) {
        if (fs.existsSync(envExamplePath)) {
            fs.copyFileSync(envExamplePath, envPath);
            console.log('✅ Created .env from .env.example');
        } else {
            console.error('❌ .env.example not found!');
            process.exit(1);
        }
    }

    // Read .env content
    let envContent = fs.readFileSync(envPath, 'utf8');

    // Extract current MASTER_PASSWORD value (uncommented line only)
    const match = envContent.match(/^MASTER_PASSWORD=(.*)$/m);
    const currentValue = match ? match[1].trim() : null;
    const placeholderValues = ['', 'your_secure_master_password_here'];

    // Skip if a real password is already set
    if (currentValue !== null && !placeholderValues.includes(currentValue)) {
        console.log('⚠️  MASTER_PASSWORD already exists in .env');
        console.log('   Skipping password generation to avoid overwriting existing value.\n');
        return;
    }

    // Generate cryptographically secure 256-bit password
    const masterPassword = crypto.randomBytes(32).toString('base64');

    // Replace placeholder or append MASTER_PASSWORD
    if (match) {
        // Replace existing (empty or placeholder) MASTER_PASSWORD line
        envContent = envContent.replace(
            /^MASTER_PASSWORD=.*$/m,
            `MASTER_PASSWORD=${masterPassword}`
        );
        console.log('✅ MASTER_PASSWORD generated and updated in .env');
    } else if (envContent.includes('# MASTER_PASSWORD=')) {
        // Uncomment and set the value
        envContent = envContent.replace(
            /# MASTER_PASSWORD=.*$/m,
            `MASTER_PASSWORD=${masterPassword}`
        );
        console.log('✅ MASTER_PASSWORD generated and added to .env');
    } else {
        // Append to end of file
        envContent += `\n# Auto-generated secure master password for private key encryption\nMASTER_PASSWORD=${masterPassword}\n`;
        console.log('✅ MASTER_PASSWORD generated and appended to .env');
    }

    // Write back to .env
    fs.writeFileSync(envPath, envContent);

    console.log('\n🔐 Security Information:');
    console.log('   • MASTER_PASSWORD is used to encrypt user private keys');
    console.log('   • Keep your .env file secure and never commit it to git');
    console.log('   • If you lose MASTER_PASSWORD, all encrypted keys are unrecoverable');
    console.log('   • Backup your .env file in a secure location\n');

    console.log('✅ Environment setup complete!\n');
    console.log('Next steps:');
    console.log('1. Configure TELEGRAM_BOT_TOKEN in .env');
    console.log('2. Run: pnpm dev\n');
}

// Run setup
setupEnvironment();
