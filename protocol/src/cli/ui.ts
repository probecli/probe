/** Terminal output in PROBE's style: ink, dim, and one vermilion accent. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const hot = c("38;2;232;63;40");
export const dim = c("38;2;154;151;142");
export const bold = c("1");

export const prompt = () => hot("›•");

export function field(label: string, value: string) {
  console.log(`  ${dim(label.padEnd(8))} ${value}`);
}

export function note(s: string) {
  console.log(dim(s));
}

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** A task line with a spinner that resolves to ✓ or ×. */
export async function task<T>(label: string, fn: () => Promise<T>, done?: (v: T) => string): Promise<T> {
  let i = 0;
  const render = (glyph: string, suffix = "") => {
    if (tty) process.stdout.write(`\r\x1b[2K${glyph} ${label}${suffix}`);
  };
  const timer = tty ? setInterval(() => render(hot(FRAMES[i++ % FRAMES.length])), 80) : null;
  try {
    const v = await fn();
    if (timer) clearInterval(timer);
    const suffix = done ? ` ${dim(done(v))}` : "";
    if (tty) render(dim("✓"), suffix), process.stdout.write("\n");
    else console.log(`✓ ${label}${suffix}`);
    return v;
  } catch (e) {
    if (timer) clearInterval(timer);
    if (tty) render(hot("×"), ` ${dim((e as Error).message)}`), process.stdout.write("\n");
    else console.log(`× ${label} ${(e as Error).message}`);
    throw e;
  }
}

export function verdictLine(index: number, verdict: string, reason: string) {
  const map: Record<string, [string, (s: string) => string, string]> = {
    accepted: ["✓", hot, "accepted"],
    duplicate: ["=", (s) => s, "duplicate"],
    failed: ["×", (s) => s, "failed verification"],
    ineligible: ["×", (s) => s, "not eligible"],
  };
  const [g, color, label] = map[verdict] ?? ["?", (s: string) => s, verdict];
  console.log(`${color(g)} ${color(`case ${index} ${label}`)}${dim(`: ${reason}`)}`);
}

export function payout(text: string) {
  console.log(`${hot("●")} ${text}`);
}

export function fail(message: string): never {
  console.error(`${hot("×")} ${message}`);
  process.exit(1);
}
