import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SessionInfo, Message } from "../types.js";

const CTRL_O_HINT = "ctrl+o";

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;
  private collapsed: boolean;

  constructor(from: SessionInfo, message: Message, theme: Theme, replyCommand?: string, bodyText?: string, collapsed = false) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
    this.collapsed = collapsed;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const senderName = this.from.name || this.from.id.slice(0, 8);
    const bodyWidth = Math.max(1, width - 2);

    if (this.collapsed) {
      // Three-line collapsed view: matches expanded box pattern
      const borderChar = "─";
      const headerLabel = ` 📨 From: ${senderName} (${this.from.cwd}) `;
      const hint = ` (${CTRL_O_HINT}) `;
      const headerText = truncateToWidth(headerLabel, bodyWidth - visibleWidth(hint), "");
      const headerPad = Math.max(0, bodyWidth - visibleWidth(headerText) - visibleWidth(hint));
      const topLine = `╭${headerText}${borderChar.repeat(headerPad)}${hint}╮`;

      // Middle line: follows same pattern as expanded — │${text}${padding}│
      const rawPreview = (this.bodyText || this.message.content.text).replace(/\n/g, " ");
      const preview = truncateToWidth(rawPreview, bodyWidth - 2, "...");
      const previewContent = ` ${preview}`;
      const midPadding = Math.max(0, bodyWidth - visibleWidth(previewContent));
      const midLine = `│${previewContent}${" ".repeat(midPadding)}│`;

      const bottomLine = `╰${borderChar.repeat(bodyWidth)}╯`;

      return [
        this.theme.fg("accent", topLine),
        this.theme.fg("accent", midLine),
        this.theme.fg("accent", bottomLine),
      ];
    }

    const lines: string[] = [];
    const borderChar = "─";
    if (width < 3) {
      return [truncateToWidth(`From ${senderName}`, width)];
    }

    const header = ` 📨 From: ${senderName} (${this.from.cwd}) `;
    const headerText = truncateToWidth(header, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`));

    const contentLines = wrapTextWithAnsi(this.bodyText || this.message.content.text, bodyWidth);
    for (const line of contentLines) {
      const text = truncateToWidth(line, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    if (this.replyCommand) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      const replyLines = wrapTextWithAnsi(this.theme.fg("dim", ` ↩ To reply: ${this.replyCommand}`), bodyWidth);
      for (const line of replyLines) {
        const text = truncateToWidth(line, bodyWidth, "");
        const padding = Math.max(0, bodyWidth - visibleWidth(text));
        lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
      }
    }

    if (this.message.content.attachments?.length) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      for (const att of this.message.content.attachments) {
        const label = this.theme.fg("dim", ` 📎 ${att.name}`);
        const text = truncateToWidth(label, bodyWidth, "");
        const padding = Math.max(0, bodyWidth - visibleWidth(text));
        lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
      }
    }

    if (this.message.replyTo && !this.message.expectsReply) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      const reply = this.theme.fg("dim", ` ↳ Reply to ${this.message.replyTo.slice(0, 8)}`);
      const text = truncateToWidth(reply, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));

    return lines;
  }
}
