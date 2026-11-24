// SPEC-110 §6 / §14 / §26 / §26.1 / §26.2: the public namespace (no authentication) with the public read
// Operations API-PUB-001..005, API-PUB-012 and API-PUB-010..011 (Goods). The route declarations and the response schemas live in the
// @off-r39x/api-contract builder (DEV-API-002/003); this file only injects the fail-closed guard, the Query
// and Path validation and the service result -> HTTP mapping (DEV-API-001). Every route is registered in
// ../routes.ts ROUTES as `public_read` (DEV-RLM-005).
//
// No token, Principal or Capability is read here: `public.read` is allowed for everyone including a Guest
// (SPEC-060 §24), the `Authorization` header and Cookie are not read (API-PUB-READ-001), and the Rate
// Limit Stage 1 middleware has already run by the time a handler is reached.
import {
  announcementRefParamSchema,
  createPublicReadRpc,
  emptyPublicQuerySchema,
  goodsRefParamSchema,
  type PublicAnnouncement,
  type PublicAnnouncementList,
  type PublicEntryOfferingList,
  type PublicEvent,
  type PublicFaqList,
  type PublicGoods,
  type PublicGoodsList,
  type PublicSponsorLogoList,
  publicAnnouncementListSchema,
  publicAnnouncementSchema,
  publicEntryOfferingListSchema,
  publicEventSchema,
  publicFaqListSchema,
  publicGoodsListSchema,
  publicGoodsSchema,
  publicSponsorLogoListSchema,
} from "@off-r39x/api-contract";
import type { RouteRegistration } from "@off-r39x/security";
import type { MiddlewareHandler } from "hono";
import type { z } from "zod";
import { type ApiEnvironment, ApiFailure } from "../failure.ts";
import { validateQuery } from "../middleware/query.ts";
import { ROUTES } from "../routes.ts";
import {
  type GoodsSaleRecord,
  listEntryOfferings,
  listGoods,
  listPublishedAnnouncements,
  listPublishedFaqs,
  listPublishedSponsorLogos,
  type PublicContentStore,
  type PublicReadResult,
  readGoods,
  readPublicEvent,
  readPublishedAnnouncement,
} from "../services/index.ts";

export interface PublicRouteDependencies {
  readonly app: {
    readonly publicContent?: PublicContentStore | undefined;
    /** SEC-WEB-026: the normalised Sponsor Logo image origin allowlist; absent or undefined fails API-PUB-012 closed. */
    readonly sponsorImageOrigins?: readonly string[] | undefined;
  };
}

/**
 * UCR-110-004 (SPEC-110 `API-PUR-ELG-001`): the Operations that can start a purchase of each kind. A kind
 * none of whose Operations is in the route registry is SALES_STOPPED in the public reads (API-PUB-005,
 * API-PUB-GDS-003, and the Karaoke availability of §27).
 */
export const PURCHASE_START_OPERATIONS = Object.freeze({
  ENTRY: Object.freeze(["API-PUR-ENTRY-001", "API-PUR-CART-001"]),
  GOODS: Object.freeze(["API-PUR-GDS-001", "API-PUR-CART-001"]),
  KARAOKE: Object.freeze(["API-PUR-KRK-001"]),
} as const);
export type PurchaseKind = keyof typeof PURCHASE_START_OPERATIONS;

/**
 * Whether a purchase Operation of `kind` is in the route registry. Derived from the registry itself, so
 * registering the purchase route is the only step that changes the answer; nothing here can be switched
 * on its own.
 */
export function isPurchaseMounted(
  routes: readonly Pick<RouteRegistration, "operationId">[],
  kind: PurchaseKind,
): boolean {
  const operations: readonly string[] = PURCHASE_START_OPERATIONS[kind];
  return routes.some(
    (route) => route.operationId !== null && operations.includes(route.operationId),
  );
}

/** API-PUB-005 / UCR-110-004: {@link isPurchaseMounted} for ENTRY. */
export function isEntryPurchaseMounted(
  routes: readonly Pick<RouteRegistration, "operationId">[],
): boolean {
  return isPurchaseMounted(routes, "ENTRY");
}

// API-PUB-GDS-002: the Goods DTO, built field by field (the same shape in the list and the detail).
const goodsDto = (goods: GoodsSaleRecord) => ({
  goods_ref: goods.publicRef,
  name: goods.name,
  description: goods.description,
  unit_price: { amount: goods.unitAmount, currency: goods.currency },
  sales_starts_at: goods.salesStartsAt,
  sales_ends_at: goods.salesEndsAt,
  purchase_limit: goods.purchaseLimit,
  availability: goods.availability,
  unavailable_reason: goods.reason,
});

// A service result -> data, or the failure the route answers (API-PUB-READ-002, API-PUB-READ-006).
function unwrap<T>(result: PublicReadResult<T>): T {
  if (result.kind === "ok") return result.data;
  if (result.kind === "not_found") throw new ApiFailure("RESOURCE_NOT_FOUND");
  if (result.kind === "inconsistent") throw new ApiFailure("INTERNAL_ERROR");
  if (result.kind === "invalid_row" || result.kind === "misconfigured")
    throw new ApiFailure("TEMPORARY_UNAVAILABLE");
  throw new ApiFailure("DATABASE_TEMPORARY_FAILURE");
}

// API-PUB-READ-006: a row the response schema refuses (for example a PUBLISHED Announcement without
// published_at) fails the whole Operation with a retryable 503; it is not guessed, skipped or sent. The
// builder checks the envelope again (DEV-API-003), so a refusal there is a producer defect (500).
function checked<S extends z.ZodType>(schema: S, dto: unknown): z.output<S> {
  const result = schema.safeParse(dto);
  if (!result.success) throw new ApiFailure("TEMPORARY_UNAVAILABLE");
  return result.data;
}

export function createPublicRoutes(dependencies: PublicRouteDependencies) {
  const { publicContent, sponsorImageOrigins } = dependencies.app;
  const purchaseRouteMounted = isPurchaseMounted(ROUTES, "ENTRY");
  const goodsPurchaseRouteMounted = isPurchaseMounted(ROUTES, "GOODS");
  // Fail closed when the store is missing; runs before the Query is validated.
  const guard: MiddlewareHandler<ApiEnvironment> = async (_c, next) => {
    if (!publicContent) throw new ApiFailure("TEMPORARY_UNAVAILABLE");
    await next();
  };
  const store = (): PublicContentStore => {
    if (!publicContent) throw new ApiFailure("TEMPORARY_UNAVAILABLE");
    return publicContent;
  };
  return createPublicReadRpc<ApiEnvironment>({
    requestId: (c) => c.get("requestId"),
    guard,
    query: validateQuery(emptyPublicQuerySchema),
    event: {
      load: async (): Promise<PublicEvent> => {
        const event = unwrap(await readPublicEvent(store()));
        return checked(publicEventSchema, {
          event_ref: event.publicRef,
          name: event.name,
          summary: event.summary,
          starts_at: event.startsAt,
          ends_at: event.endsAt,
          business_timezone: event.businessTimezone,
          venue_name: event.venueName,
          venue_details: event.venueDetails,
          access_information: event.accessInformation,
          participant_notices: event.participantNotices,
        });
      },
    },
    faqs: {
      load: async (): Promise<PublicFaqList> => {
        const faqs = unwrap(await listPublishedFaqs(store()));
        return checked(publicFaqListSchema, {
          items: faqs.map((faq) => ({
            faq_ref: faq.publicRef,
            question: faq.question,
            answer: faq.answer,
            sort_order: faq.sortOrder,
          })),
        });
      },
    },
    announcements: {
      load: async (): Promise<PublicAnnouncementList> => {
        const announcements = unwrap(await listPublishedAnnouncements(store()));
        return checked(publicAnnouncementListSchema, {
          items: announcements.map((announcement) => ({
            announcement_ref: announcement.publicRef,
            title: announcement.title,
            published_at: announcement.publishedAt,
            excerpt: announcement.excerpt,
            excerpt_truncated: announcement.excerptTruncated,
          })),
        });
      },
    },
    announcement: {
      load: async (c): Promise<PublicAnnouncement> => {
        // API-PUB-004 Path: a UUID of any case; the lower-case value is the only one the store sees.
        const ref = announcementRefParamSchema.safeParse(c.req.param("announcement_ref"));
        if (!ref.success) throw new ApiFailure("VALIDATION_FAILED");
        const announcement = unwrap(await readPublishedAnnouncement(store(), ref.data));
        return checked(publicAnnouncementSchema, {
          announcement_ref: announcement.publicRef,
          title: announcement.title,
          body: announcement.body,
          published_at: announcement.publishedAt,
        });
      },
    },
    entryOfferings: {
      load: async (): Promise<PublicEntryOfferingList> => {
        const offerings = unwrap(await listEntryOfferings(store(), { purchaseRouteMounted }));
        return checked(publicEntryOfferingListSchema, {
          items: offerings.map((offering) => ({
            offering_ref: offering.publicRef,
            name: offering.name,
            description: offering.description,
            unit_price: { amount: offering.unitAmount, currency: offering.currency },
            sales_starts_at: offering.salesStartsAt,
            sales_ends_at: offering.salesEndsAt,
            purchase_limit: offering.purchaseLimit,
            availability: offering.availability,
            unavailable_reason: offering.reason,
          })),
        });
      },
    },
    sponsorLogos: {
      load: async (): Promise<PublicSponsorLogoList> => {
        const logos = unwrap(
          await listPublishedSponsorLogos(store(), { imageOrigins: sponsorImageOrigins }),
        );
        return checked(publicSponsorLogoListSchema, {
          items: logos.map((logo) => ({
            logo_ref: logo.publicRef,
            display_name: logo.displayName,
            image_url: logo.imageUrl,
            link_url: logo.linkUrl,
            sort_order: logo.sortOrder,
          })),
        });
      },
    },
    goods: {
      load: async (): Promise<PublicGoodsList> => {
        const goods = unwrap(
          await listGoods(store(), { purchaseRouteMounted: goodsPurchaseRouteMounted }),
        );
        return checked(publicGoodsListSchema, { items: goods.map(goodsDto) });
      },
    },
    goodsDetail: {
      load: async (c): Promise<PublicGoods> => {
        // API-PUB-011 Path (§9 publicRefInput): a UUID of any case; the lower-case value is the only one the store sees.
        const ref = goodsRefParamSchema.safeParse(c.req.param("goods_ref"));
        if (!ref.success) throw new ApiFailure("VALIDATION_FAILED");
        const goods = unwrap(
          await readGoods(store(), ref.data, { purchaseRouteMounted: goodsPurchaseRouteMounted }),
        );
        return checked(publicGoodsSchema, goodsDto(goods));
      },
    },
  });
}
