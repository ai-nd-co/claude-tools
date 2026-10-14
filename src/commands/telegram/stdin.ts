import chalk from 'chalk';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);

    setTimeout(() => {
      if (chunks.length === 0) {
        resolve('');
      }
    }, 100);
  });
}

export async function resolveMessageArg(message: string): Promise<string> {
  if (message !== '-') {
    return message;
  }

  const stdinContent = await readStdin();
  if (!stdinContent) {
    console.error(chalk.red('Error: No input received from stdin'));
    process.exit(1);
  }

  return stdinContent;
}
