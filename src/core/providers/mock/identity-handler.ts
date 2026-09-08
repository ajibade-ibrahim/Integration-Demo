/**
 * Mock identity sync handler.
 *
 * Serves fixture data through the same paged, association-bearing interface the
 * real handlers use, so the sync engine cannot tell the difference.
 */

import type { RawRecord } from "../../types/common";
import type {
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import {
  MOCK_COMPANIES,
  MOCK_PAGE_SIZE,
  MOCK_PEOPLE,
} from "./fixtures";

function* paginate<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

export const mockIdentityHandler: SyncHandler = {
  async *fetchPages(_ctx: HandlerContext): AsyncIterable<SourcePage> {
    // Companies first — the sync engine depends on that ordering to resolve
    // contact associations without a second pass.
    for (const page of paginate(MOCK_COMPANIES, MOCK_PAGE_SIZE)) {
      yield { object: "customer", records: page as unknown as RawRecord[] };
    }
    for (const page of paginate(MOCK_PEOPLE, MOCK_PAGE_SIZE)) {
      yield { object: "contact", records: page as unknown as RawRecord[] };
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    const id = record["id"];
    return typeof id === "string" ? id : undefined;
  },

  externalCustomerIdOf(contact: RawRecord): string | undefined {
    const id = contact["companyId"];
    return typeof id === "string" ? id : undefined;
  },
};
