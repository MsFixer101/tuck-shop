// PDF → text extraction via poppler (pdftotext) with a PyMuPDF fallback.
// Self-contained: own path consts (does not share capabilities.js PYTHON).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PDFTOTEXT = process.env.PDFTOTEXT_PATH || '/opt/homebrew/bin/pdftotext';
const PYTHON = process.env.PYTHON_PATH || '/opt/homebrew/bin/python3.11';

const PYMUPDF_SCRIPT =
  'import sys, fitz\n' +
  'try:\n' +
  '    d = fitz.open(sys.argv[1])\n' +
  '    sys.stdout.write("\\n\\n".join(p.get_text() for p in d))\n' +
  'except Exception as e:\n' +
  '    sys.stderr.write("ERR:" + str(e))\n' +
  '    sys.exit(1)';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function normalize(text) {
  if (!text) return null;
  let t = text.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.trim();
  return t || null;
}

export async function pdfToText(buffer) {
  const tmp = join(tmpdir(), 'tuck-pdf-' + randomUUID() + '.pdf');
  try {
    await writeFile(tmp, buffer);

    // Primary: pdftotext (poppler).
    const primary = await run(PDFTOTEXT, ['-enc', 'UTF-8', '-q', tmp, '-']);
    let text = null;
    if (!primary.err && primary.stdout && primary.stdout.trim()) {
      text = primary.stdout;
    }

    // Fallback: PyMuPDF.
    if (text == null) {
      const fallback = await run(PYTHON, ['-c', PYMUPDF_SCRIPT, tmp]);
      if (!fallback.err && fallback.stdout && fallback.stdout.trim()) {
        text = fallback.stdout;
      }
    }

    return normalize(text);
  } catch {
    return null;
  } finally {
    unlink(tmp).catch(() => {});
  }
}
