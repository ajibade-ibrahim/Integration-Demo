/**
 * The communication schema: what a Gmail message can be mapped into.
 *
 * Bodies are deliberately uncapped here. The list page shows a snippet; the
 * detail page reads the full text and the escaped HTML source. No target exists
 * for a participant, a primary party, or a truncation flag: those are derived
 * by the communication matcher, not typed by a user.
 */

import type { ObjectSchema } from "./object-schema";
import { MESSAGE_DIRECTIONS } from "./types/common";

const MESSAGE_SCHEMA: ObjectSchema = {
  object: "message",
  label: "Message",
  fields: [
    { name: "fromEmail", label: "From email", kind: "email", maxLength: 254 },
    { name: "fromName", label: "From name", kind: "string", maxLength: 255 },
    {
      name: "toEmails",
      label: "To addresses (comma-separated or JSON array)",
      kind: "string",
    },
    {
      name: "ccEmails",
      label: "Cc addresses (comma-separated or JSON array)",
      kind: "string",
    },
    { name: "subject", label: "Subject", kind: "string", maxLength: 998 },
    { name: "snippet", label: "Snippet", kind: "string" },
    { name: "bodyText", label: "Body (plain text)", kind: "string" },
    {
      name: "bodyHtml",
      label: "Body (HTML source; never rendered)",
      kind: "string",
    },
    { name: "sentAt", label: "Sent at", kind: "date", required: true },
    { name: "threadId", label: "Thread ID", kind: "string", maxLength: 255 },
    {
      name: "direction",
      label: "Direction",
      kind: "enum",
      enumValues: MESSAGE_DIRECTIONS,
      required: true,
    },
  ],
};

export const MESSAGE_OBJECT_SCHEMA = {
  message: MESSAGE_SCHEMA,
} as const;

export type CommunicationObject = keyof typeof MESSAGE_OBJECT_SCHEMA;
