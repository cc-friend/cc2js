// Tiny stderr logger with elapsed-time stamps. Node 18+, no deps.
// All progress goes to stderr so stdout stays clean for piping.

export interface Logger {
  step(msg: string): void;
  info(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  err(msg: string): void;
  raw(msg: string): void;
  reset(): void;
  /**
   * Redraw `render()` on one live line until the returned stop() is called, so a
   * long silent step does not look hung. Optional: a custom logger may leave it out.
   */
  progress?(render: () => string): () => void;
  c: Record<'dim' | 'green' | 'yellow' | 'red' | 'cyan' | 'bold', (s: unknown) => string>;
}

const useColor = process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
function paint(code: string): (s: unknown) => string {
  return (s) => (useColor ? '\x1b[' + code + 'm' + s + '\x1b[0m' : String(s));
}
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');
const bold = paint('1');

let t0 = Date.now();
function stamp(): string {
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  return dim('[' + (s.length < 5 ? ' ' : '') + s + 's]');
}

// A progress line is on screen (cursor still on it): wipe it before printing over.
let live = false;
function clearLive(): string {
  if (!live) return '';
  live = false;
  return '\r\x1b[K';
}
function line(sym: string, msg: string): void {
  process.stderr.write(clearLive() + stamp() + ' ' + sym + ' ' + msg + '\n');
}

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'); // color codes
function progress(render: () => string): () => void {
  // only on an interactive terminal: \r redraws make a mess of piped logs
  if (!process.stderr.isTTY || process.env.TERM === 'dumb') return () => {};
  let frame = 0;
  const draw = () => {
    let text = stamp() + ' ' + cyan(FRAMES[frame++ % FRAMES.length]) + ' ' + render();
    // a line that wraps can no longer be wiped by \r, so never outgrow the terminal
    const room = (process.stderr.columns || 80) - 1;
    if (text.replace(SGR, '').length > room) text = text.replace(SGR, '').slice(0, room);
    process.stderr.write('\r\x1b[K' + text);
    live = true;
  };
  draw();
  const timer = setInterval(draw, 100);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    process.stderr.write(clearLive());
  };
}

const log: Logger = {
  step: (msg) => line(cyan('▶'), bold(msg)),
  info: (msg) => line(dim('·'), msg),
  ok: (msg) => line(green('✓'), msg),
  warn: (msg) => line(yellow('!'), yellow(msg)),
  err: (msg) => line(red('✗'), red(msg)),
  raw: (msg) => process.stderr.write(msg),
  reset: () => {
    t0 = Date.now();
  },
  progress,
  c: { dim, green, yellow, red, cyan, bold }
};

export default log;
