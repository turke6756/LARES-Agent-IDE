/**
 * A small VT screen model for decisions that must inspect what is visible now,
 * rather than matching against the append-only PTY scrollback ring.
 *
 * This intentionally implements the cursor/erase operations used by provider
 * TUIs. Unknown escape sequences are ignored instead of leaking their bytes
 * into the rendered screen.
 */
export class TerminalScreenState {
  private lines: string[][];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;

  constructor(private cols = 120, private rows = 40) {
    this.lines = this.blankLines();
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.lines = this.lines.slice(0, this.rows);
    while (this.lines.length < this.rows) this.lines.push([]);
    for (const line of this.lines) line.length = Math.min(line.length, this.cols);
    this.row = Math.min(this.row, this.rows - 1);
    this.col = Math.min(this.col, this.cols - 1);
  }

  write(data: string): void {
    for (let i = 0; i < data.length;) {
      const ch = data[i];
      if (ch === '\x1b') {
        const next = data[i + 1];
        if (next === '[') {
          const match = /^\x1b\[([?>!]?[0-9;:]*)([ -/]*)?([@-~])/.exec(data.slice(i));
          if (match) {
            this.applyCsi(match[1], match[3]);
            i += match[0].length;
            continue;
          }
        } else if (next === ']') {
          const bel = data.indexOf('\x07', i + 2);
          const st = data.indexOf('\x1b\\', i + 2);
          const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : data.length;
          i = end;
          continue;
        } else if (next === '7') {
          this.savedRow = this.row;
          this.savedCol = this.col;
          i += 2;
          continue;
        } else if (next === '8') {
          this.row = this.savedRow;
          this.col = this.savedCol;
          i += 2;
          continue;
        } else if (next !== undefined) {
          i += 2;
          continue;
        }
      }

      if (ch === '\r') {
        this.col = 0;
      } else if (ch === '\n') {
        this.lineFeed();
      } else if (ch === '\b') {
        this.col = Math.max(0, this.col - 1);
      } else if (ch === '\t') {
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      } else if (ch >= ' ') {
        this.put(ch);
      }
      i += ch.length;
    }
  }

  render(): string {
    const rendered = this.lines.map((line) => line.join('').replace(/\s+$/, ''));
    while (rendered.length > 0 && rendered[rendered.length - 1] === '') rendered.pop();
    return rendered.join('\n');
  }

  private blankLines(): string[][] {
    return Array.from({ length: this.rows }, () => [] as string[]);
  }

  private reset(): void {
    this.lines = this.blankLines();
    this.row = 0;
    this.col = 0;
  }

  private params(raw: string): number[] {
    const plain = raw.replace(/^[?>!]/, '');
    return plain === '' ? [0] : plain.split(';').map((part) => Number(part || 0));
  }

  private applyCsi(raw: string, command: string): void {
    const p = this.params(raw);
    const n = p[0] || 1;
    switch (command) {
      case 'A': this.row = Math.max(0, this.row - n); break;
      case 'B': this.row = Math.min(this.rows - 1, this.row + n); break;
      case 'C': this.col = Math.min(this.cols - 1, this.col + n); break;
      case 'D': this.col = Math.max(0, this.col - n); break;
      case 'E': this.row = Math.min(this.rows - 1, this.row + n); this.col = 0; break;
      case 'F': this.row = Math.max(0, this.row - n); this.col = 0; break;
      case 'G': this.col = Math.min(this.cols - 1, Math.max(0, n - 1)); break;
      case 'd': this.row = Math.min(this.rows - 1, Math.max(0, n - 1)); break;
      case 'H':
      case 'f':
        this.row = Math.min(this.rows - 1, Math.max(0, (p[0] || 1) - 1));
        this.col = Math.min(this.cols - 1, Math.max(0, (p[1] || 1) - 1));
        break;
      case 'J': this.eraseDisplay(p[0] || 0); break;
      case 'K': this.eraseLine(p[0] || 0); break;
      case 's': this.savedRow = this.row; this.savedCol = this.col; break;
      case 'u': this.row = this.savedRow; this.col = this.savedCol; break;
      case 'S': this.scrollUp(n); break;
      case 'T': this.scrollDown(n); break;
      case 'L': this.insertLines(n); break;
      case 'M': this.deleteLines(n); break;
      case 'P': this.lines[this.row].splice(this.col, n); break;
      case 'X': this.eraseChars(n); break;
      case 'h':
      case 'l':
        if (/^\?(47|1047|1049)(;|$)/.test(raw)) this.reset();
        break;
    }
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    const line = this.lines[this.row];
    while (line.length < this.col) line.push(' ');
    line[this.col] = ch;
    this.col++;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) this.row++;
    else this.scrollUp(1);
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.lines = this.blankLines();
    } else if (mode === 0) {
      this.lines[this.row].length = Math.min(this.lines[this.row].length, this.col);
      for (let r = this.row + 1; r < this.rows; r++) this.lines[r] = [];
    } else if (mode === 1) {
      this.lines[this.row].splice(0, this.col + 1, ...Array(this.col + 1).fill(' '));
      for (let r = 0; r < this.row; r++) this.lines[r] = [];
    }
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.row];
    if (mode === 2) this.lines[this.row] = [];
    else if (mode === 0) line.length = Math.min(line.length, this.col);
    else line.splice(0, this.col + 1, ...Array(this.col + 1).fill(' '));
  }

  private eraseChars(count: number): void {
    const line = this.lines[this.row];
    while (line.length < this.col + count) line.push(' ');
    line.splice(this.col, count, ...Array(count).fill(' '));
  }

  private scrollUp(count: number): void {
    for (let i = 0; i < count; i++) {
      this.lines.shift();
      this.lines.push([]);
    }
  }

  private scrollDown(count: number): void {
    for (let i = 0; i < count; i++) {
      this.lines.pop();
      this.lines.unshift([]);
    }
  }

  private insertLines(count: number): void {
    this.lines.splice(this.row, 0, ...Array.from({ length: count }, () => [] as string[]));
    this.lines.length = this.rows;
  }

  private deleteLines(count: number): void {
    this.lines.splice(this.row, count);
    while (this.lines.length < this.rows) this.lines.push([]);
  }
}
