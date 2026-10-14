// Wispr Flow transcription command

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { getWisprCredentials, type WisprCredentials } from './wispr-auth.js';

const WISPR_API_ENDPOINT = 'https://api.wisprflow.ai/llm/asr';

interface TranscribeOptions {
  language: string;
  json?: boolean;
  quiet?: boolean;
}

interface TranscriptionResult {
  content: string;
  detected_language: string;
}

async function convertToWav(inputPath: string): Promise<Buffer> {
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === '.wav') {
    return fs.readFileSync(inputPath);
  }

  // Convert to WAV using ffmpeg (16kHz mono PCM)
  const outputPath = inputPath.replace(ext, '.converted.wav');

  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}"`,
      { stdio: 'pipe' }
    );
    const wavBuffer = fs.readFileSync(outputPath);
    fs.unlinkSync(outputPath); // Clean up temp file
    return wavBuffer;
  } catch (error) {
    throw new Error(
      `Failed to convert audio to WAV. Make sure ffmpeg is installed.\n` +
      `Install: https://ffmpeg.org/download.html`
    );
  }
}

async function callWisprAPI(
  audioBuffer: Buffer,
  credentials: WisprCredentials,
  language: string
): Promise<TranscriptionResult> {
  const audioBase64 = audioBuffer.toString('base64');

  const payload = {
    audio: audioBase64,
    language,
    prompt: '',
  };

  const response = await fetch(WISPR_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();

    if (response.status === 401) {
      throw new Error('Authentication failed. Your Wispr token may have expired. Open Wispr Flow to refresh it.');
    }

    throw new Error(`Wispr API error: ${response.status} ${response.statusText}\n${text}`);
  }

  return await response.json() as TranscriptionResult;
}

export async function transcribe(audioFile: string, options: TranscribeOptions): Promise<void> {
  // Resolve relative paths
  const absolutePath = path.resolve(audioFile);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Audio file not found: ${absolutePath}`);
  }

  const quiet = options.quiet;

  // Get credentials
  if (!quiet) {
    console.log(chalk.dim('Loading Wispr credentials...'));
  }

  const credentials = await getWisprCredentials();

  // Check token expiry
  if (credentials.expiresAt < new Date()) {
    throw new Error('Wispr access token has expired. Please open Wispr Flow to refresh it.');
  }

  // Convert audio
  if (!quiet) {
    console.log(chalk.dim(`Converting ${path.basename(absolutePath)} to WAV...`));
  }

  const wavBuffer = await convertToWav(absolutePath);

  if (!quiet) {
    console.log(chalk.dim(`Transcribing (${(wavBuffer.length / 1024).toFixed(1)} KB)...`));
  }

  // Call API
  const result = await callWisprAPI(wavBuffer, credentials, options.language);

  // Output result
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (quiet) {
    console.log(result.content);
  } else {
    console.log('');
    console.log(chalk.bold('Transcription:'));
    console.log(result.content);

    if (result.detected_language !== options.language) {
      console.log('');
      console.log(chalk.dim(`Detected language: ${result.detected_language}`));
    }
  }
}
