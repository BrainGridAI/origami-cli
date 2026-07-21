import pc from "picocolors";

let enabled = pc.isColorSupported;

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function colorEnabled(): boolean {
  return enabled;
}

type Colorizer = (input: string) => string;

function wrap(fn: (input: string) => string): Colorizer {
  return (input: string) => (enabled ? fn(input) : input);
}

/** Color helpers that respect the runtime color toggle (NO_COLOR / --no-color / non-TTY). */
export const color = {
  bold: wrap(pc.bold),
  dim: wrap(pc.dim),
  italic: wrap(pc.italic),
  underline: wrap(pc.underline),
  red: wrap(pc.red),
  green: wrap(pc.green),
  yellow: wrap(pc.yellow),
  blue: wrap(pc.blue),
  magenta: wrap(pc.magenta),
  cyan: wrap(pc.cyan),
  gray: wrap(pc.gray),
};
