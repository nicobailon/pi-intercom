import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo, Message } from "../types.ts";
import { relaySenderName } from "../cross-machine-envelope.ts";

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;
  // Caches assume message/bodyText never mutate after construction; theme
  // styling stays outside the caches so live theme changes apply per render.
  private collapsedPreview?: string;
  private wrappedBody?: { width: number; lines: string[] };

  constructor(
    from: SessionInfo,
    message: Message,
    theme: Theme,
    replyCommand?: string,
    bodyText?: string,
    collapsed = false,
    private expansionState: { expanded: boolean } = { expanded: !collapsed },
  ) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left"
      || event.shift || event.alt || event.ctrl || (event.clickCount ?? 1) !== 1) {
      return undefined;
    }
    this.expansionState.expanded = !this.expansionState.expanded;
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const collapsed = !this.expansionState.expanded;
    const lines: string[] = [];
    const borderChar = "─";
    const remoteSender = this.message.crossMachine && relaySenderName(this.message.crossMachine.origin);
    const senderName = remoteSender
      ? `${remoteSender} · unverified cross-machine`
      : this.from.name || this.from.id.slice(0, 8);
    const replyLabel = remoteSender
      ? `To send a new message to ${remoteSender}:`
      : "To reply:";
    if (width < 3) {
      return [truncateToWidth(`From ${senderName}`, width)];
    }
    const bodyWidth = Math.max(1, width - 2);

    const header = ` From: ${senderName} (${this.from.cwd}) `;
    const headerText = truncateToWidth(collapsed ? `${header} Ctrl+O expands ` : header, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(
      this.theme.fg("muted", "╭") +
        this.theme.fg("toolTitle", headerText) +
        this.theme.fg("muted", `${borderChar.repeat(headerPadding)}╮`),
    );

    const frameLine = (content: string): string => {
      const text = truncateToWidth(content, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      return this.theme.fg("muted", "│") + text + this.theme.fg("muted", `${" ".repeat(padding)}│`);
    };

    if (collapsed) {
      this.collapsedPreview ??= (this.bodyText || this.message.content.text).replace(/\s+/g, " ").trim();
      lines.push(frameLine(this.theme.fg("text", this.collapsedPreview)));

      const meta: string[] = [];
      if (this.replyCommand) meta.push(`${replyLabel} ${this.replyCommand}`);
      if (this.message.content.attachments?.length) {
        const count = this.message.content.attachments.length;
        meta.push(`${count} attachment${count === 1 ? "" : "s"}`);
      }
      if (this.message.provenance?.type === "extension_outbox") meta.push(`Via ${this.message.provenance.extensionName}`);
      if (this.message.replyTo && !this.message.expectsReply) meta.push(`Reply to ${this.message.replyTo.slice(0, 8)}`);
      meta.push("Ctrl+O to expand · Click message (fullscreen)");

      lines.push(frameLine(this.theme.fg("dim", ` ${meta.join(" · ")}`)));
      lines.push(this.theme.fg("muted", `╰${borderChar.repeat(bodyWidth)}╯`));
      return lines;
    }

    if (this.wrappedBody?.width !== bodyWidth) {
      this.wrappedBody = {
        width: bodyWidth,
        lines: wrapTextWithAnsi(this.bodyText || this.message.content.text, bodyWidth),
      };
    }
    for (const line of this.wrappedBody.lines) {
      lines.push(frameLine(this.theme.fg("text", line)));
    }

    if (this.replyCommand) {
      lines.push(frameLine(""));
      const replyLines = wrapTextWithAnsi(this.theme.fg("dim", ` ${replyLabel} ${this.replyCommand}`), bodyWidth);
      for (const line of replyLines) {
        lines.push(frameLine(line));
      }
    }

    if (this.message.content.attachments?.length) {
      lines.push(frameLine(""));
      for (const att of this.message.content.attachments) {
        lines.push(frameLine(this.theme.fg("dim", ` Attachment: ${att.name}`)));
      }
    }

    if (this.message.replyTo && !this.message.expectsReply) {
      lines.push(frameLine(""));
      lines.push(frameLine(this.theme.fg("dim", ` Reply to ${this.message.replyTo.slice(0, 8)}`)));
    }

    if (this.message.provenance?.type === "extension_outbox") {
      lines.push(frameLine(""));
      lines.push(frameLine(this.theme.fg("dim", ` Via extension: ${this.message.provenance.extensionName}`)));
    }

    lines.push(this.theme.fg("muted", `╰${borderChar.repeat(bodyWidth)}╯`));

    return lines;
  }
}
