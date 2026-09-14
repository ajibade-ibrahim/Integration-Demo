/**
 * Human verdicts on identity: "same company" and "not the same company".
 *
 * POST records one, DELETE withdraws it. Both are about *customers*, not
 * accounts — an account id is created, absorbed and reaped by every pass, so a
 * verdict anchored to one would evaporate the first time the grouping it
 * described changed. A `Customer` row survives re-sync and cascades away with
 * its integration, which is exactly the lifetime a verdict should have.
 *
 * ## Why POST takes a list rather than a pair
 *
 * The database row is a pair, and the algebra is defined on pairs. But neither
 * of the two things a user actually asks for is one pair, and issuing them as
 * separate requests would make a half-applied merge a reachable state.
 *
 *   **"These two accounts are the same company."** Asserting `same` between one
 *   member of each is not enough. The pass clusters by assertion, so that
 *   cluster holds two records while their accounts hold four — and an account
 *   with a member outside the cluster is still a rival for the cluster's keys,
 *   so the two accounts contest rather than merge and one straggler moves. The
 *   caller sends one member of the surviving account against **every** member
 *   of the other, which puts that whole account inside the cluster; it then
 *   stops being a rival, its last member leaves it empty, and it is absorbed.
 *
 *   **"This record does not belong here."** A veto is per candidate account,
 *   evaluated against the members of it that are outside the cluster. One
 *   `distinct` pair leaves the other members holding the account, so the record
 *   is still pulled back onto it. The caller sends the record against every
 *   other member, which is what the sentence means anyway.
 *
 * So the route takes `customerId` and `otherCustomerIds`, and writes one row
 * per pair. The canonical ordering that makes the unique constraint meaningful
 * is applied per pair, inside `upsertAssertion`.
 *
 * The DELETE matters as much as the POST, which is why it is here rather than
 * deferred. An assertion is the one thing the resolver will never revise on its
 * own: a wrong `distinct` keeps two halves of a company apart forever, and a
 * wrong `same` keeps two companies merged, with no inference that can undo
 * either.
 *
 * Neither verb runs the pass. The page does that through
 * `/api/identity/resolve` once the user has finished, so marking three pairs
 * costs one whole-tenant pass rather than three.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import {
  deleteAssertion,
  upsertAssertion,
  type AssertionRow,
} from "@/core/repositories/identity-repository";
import { isIdentityAssertionKind } from "@/core/types/common";
import { currentUserId } from "@/lib/current-user";

/** A note is a hint to the user's future self, not a document. */
const MAX_NOTE_LENGTH = 500;

/**
 * Enough for either action against any realistic account, and small enough
 * that a malformed request cannot turn into a long write loop.
 */
const MAX_PAIRS_PER_REQUEST = 100;

export async function POST(request: Request): Promise<NextResponse> {
  bootstrap();

  const body = (await request.json().catch(() => ({}))) as {
    kind?: unknown;
    customerId?: unknown;
    otherCustomerIds?: unknown;
    note?: unknown;
  };

  if (!isIdentityAssertionKind(body.kind)) {
    return NextResponse.json(
      { error: "kind must be 'same' or 'distinct'" },
      { status: 400 }
    );
  }
  if (typeof body.customerId !== "string" || body.customerId === "") {
    return NextResponse.json({ error: "customerId is required" }, { status: 400 });
  }
  if (
    !Array.isArray(body.otherCustomerIds) ||
    !body.otherCustomerIds.every((id): id is string => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "otherCustomerIds must be an array of customer ids" },
      { status: 400 }
    );
  }

  // Self-pairs dropped here rather than left to `upsertAssertion` to refuse:
  // "every other member" is the natural way for a caller to build this list,
  // and an account's own anchor is in it.
  const others = [...new Set(body.otherCustomerIds)].filter(
    (id) => id !== body.customerId && id !== ""
  );

  if (others.length === 0) {
    return NextResponse.json(
      { error: "otherCustomerIds must name at least one other customer" },
      { status: 400 }
    );
  }
  if (others.length > MAX_PAIRS_PER_REQUEST) {
    return NextResponse.json(
      { error: `At most ${MAX_PAIRS_PER_REQUEST} pairs per request` },
      { status: 400 }
    );
  }

  const note =
    typeof body.note === "string" && body.note.trim() !== ""
      ? body.note.trim().slice(0, MAX_NOTE_LENGTH)
      : undefined;

  const userId = await currentUserId();
  const written: AssertionRow[] = [];
  const refused: string[] = [];

  for (const otherCustomerId of others) {
    const assertion = await upsertAssertion({
      userId,
      kind: body.kind,
      customerIdA: body.customerId,
      customerIdB: otherCustomerId,
      ...(note === undefined ? {} : { note }),
    });
    if (assertion === undefined) refused.push(otherCustomerId);
    else written.push(assertion);
  }

  // Nothing landed, so nothing named a customer this user owns. 404 for that
  // as well as for "no such id", matching `findIntegrationForUser`:
  // distinguishing them would confirm that an id names a real customer, which
  // is exactly what someone probing ids wants to learn.
  if (written.length === 0) {
    return NextResponse.json(
      { error: "Those customers could not be asserted about" },
      { status: 404 }
    );
  }

  // A partial result is reported rather than rolled back. Every pair written is
  // true on its own, and the pass reads whatever is there — so the useful
  // answer to "one of these ids was stale" is a weaker grouping plus a list of
  // what did not take, not the loss of the pairs that were fine.
  return NextResponse.json({ assertions: written, refused });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  bootstrap();

  // The id rides in the query string because DELETE bodies are not carried
  // reliably by every client, and this needs one identifier rather than a
  // document.
  const id = new URL(request.url).searchParams.get("id");
  if (id === null || id === "") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const removed = await deleteAssertion(await currentUserId(), id);
  if (!removed) {
    return NextResponse.json({ error: "Assertion not found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
