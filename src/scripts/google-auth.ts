import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { OAuth2Client } from 'google-auth-library';
import { URL } from 'url';

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events.readonly'];

async function getCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing ${CREDENTIALS_PATH}. Please download it from Google Cloud Console.`);
  }
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const keys = JSON.parse(content);
  return keys.installed || keys.web;
}

export async function getValidToken() {
  const credentials = await getCredentials();
  const clientId = credentials.client_id;
  const clientSecret = credentials.client_secret;
  
  // Use http://127.0.0.1:3000 for loopback OAuth flow
  const redirectUri = 'http://127.0.0.1:3000';
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);

  if (fs.existsSync(TOKEN_PATH)) {
    const tokenData = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    client.setCredentials(tokenData);
    console.log(`Loaded token from ${TOKEN_PATH}.`);
    return client;
  }

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent to ensure we get a refresh token
  });

  console.log('Authorize this app by visiting this url:');
  console.log(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlObj = new URL(req.url!, `http://127.0.0.1:3000`);
        if (urlObj.pathname === '/') {
          const qsCode = urlObj.searchParams.get('code');
          if (qsCode) {
            res.end('Authentication successful! You can close this window.');
            server.close();
            resolve(qsCode);
          } else {
            res.end('Authentication failed: no code provided.');
            server.close();
            reject(new Error('No code provided'));
          }
        }
      } catch (e) {
        reject(e);
      }
    }).listen(3000, () => {
      console.log('Listening on http://127.0.0.1:3000 to receive the OAuth callback...');
    });
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`Token saved to ${TOKEN_PATH}`);

  return client;
}

// If run directly from CLI
if (require.main === module) {
  console.log('Local developer helper used to authorize Google Calendar once and obtain the refresh token required for deployment.');
  getValidToken().then((client) => {
    console.log('\n--- SUCCESS ---');
    console.log('Google Calendar authentication successful.');
    if (client.credentials.refresh_token) {
      console.log('\nPlace the following refresh token into your GOOGLE_REFRESH_TOKEN environment variable:');
      console.log(client.credentials.refresh_token);
      console.log('\nYou must also set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    } else {
      console.log('No refresh token received. You may need to revoke the app and try again to force a new consent screen.');
    }
    process.exit(0);
  }).catch(err => {
    console.error('Error during Google Auth:', err);
    process.exit(1);
  });
}
