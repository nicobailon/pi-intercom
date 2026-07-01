import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo, Message } from "../types.ts";

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;
  private collapsed: boolean;

  constructor(
    from: SessionInfo,
    message: Message,
    theme: Theme,
    replyCommand?: string,
    bodyText?: string,
    collapsed = false,
  ) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
    this.collapsed = collapsed;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const borderChar = "─";
    const senderName = this.from.name || this.from.id.slice(0, 8);
    if (width < 3) {
      return [truncateToWidth(`From ${senderName}`, width)];
    }
    const bodyWidth = Math.max(1, width - 2);

    const header = ` 📨 From: ${senderName} (${this.from.cwd}) `;
    const headerText = truncateToWidth(this.collapsed ? `${header} Ctrl+O expands ` : header, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`));

    if (this.collapsed) {
      const preview = (this.bodyText || this.message.content.text).replace(/\s+/g, " ").trim();
      const previewText = truncateToWidth(preview, bodyWidth, "");
      const previewPadding = Math.max(0, bodyWidth - visibleWidth(previewText));
      lines.push(this.theme.fg("accent", `│${previewText}${" ".repeat(previewPadding)}│`));

      const meta: string[] = [];
      if (this.replyCommand) meta.push(`↩ To reply: ${this.replyCommand}`);
      if (this.message.content.attachments?.length) {
        const count = this.message.content.attachments.length;
        meta.push(`📎 ${count} attachment${count === 1 ? "" : "s"}`);
      }
      if (this.message.replyTo && !this.message.expectsReply) meta.push(`↳ Reply to ${this.message.replyTo.slice(0, 8)}`);
      meta.push("Ctrl+O to expand");

      const metaText = truncateToWidth(this.theme.fg("dim", ` ${meta.join(" · ")}`), bodyWidth, "");
      const metaPadding = Math.max(0, bodyWidth - visibleWidth(metaText));
      lines.push(this.theme.fg("accent", `│${metaText}${" ".repeat(metaPadding)}│`));
      lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
      return lines;
    }

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
