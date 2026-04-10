import { getSupabaseAdmin } from "../../config/supabase.config";
import { AuthService } from "./auth.service";

jest.mock("../../config/supabase.config", () => ({
  getSupabaseAdmin: jest.fn(),
  getSupabaseClient: jest.fn(),
}));

describe("AuthService completeRegistration", () => {
  let service: AuthService;
  let subscriptionService: { syncMemberQuantity: jest.Mock };
  let companyService: { acceptNewClientInvitationLinkRequest: jest.Mock };

  beforeEach(() => {
    subscriptionService = {
      syncMemberQuantity: jest.fn().mockResolvedValue(undefined),
    };
    companyService = {
      acceptNewClientInvitationLinkRequest: jest.fn().mockResolvedValue(undefined),
    };

    service = new AuthService(
      subscriptionService as any,
      companyService as any,
    );

    jest.mocked(getSupabaseAdmin).mockReset();
  });

  it("accepts a pending new client link request after the invited merchant completes registration", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === "profiles") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: { id: "user-1" },
                  error: null,
                }),
              }),
            })),
            update: jest.fn(() => ({
              eq: jest.fn().mockResolvedValue({ error: null }),
            })),
          };
        }

        if (table === "company_invitations") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                not: jest.fn().mockReturnValue({
                  order: jest.fn().mockReturnValue({
                    limit: jest.fn().mockReturnValue({
                      single: jest.fn().mockResolvedValue({
                        data: {
                          role: "merchant_admin",
                          company_id: "company-1",
                          invited_by: "cabinet-owner-1",
                        },
                      }),
                    }),
                  }),
                }),
              }),
            })),
          };
        }

        if (table === "user_companies") {
          return {
            update: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockResolvedValue({ error: null }),
              }),
            })),
            select: jest.fn(() => ({
              eq: jest.fn().mockResolvedValue({
                data: [{ company_id: "company-1" }],
              }),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any);

    const result = await service.completeRegistration(
      "merchant-admin@example.com",
      {
        email: "merchant-admin@example.com",
        first_name: "Jane",
        last_name: "Doe",
        company_creation_mode: "join_only",
        role: "merchant_admin",
      },
    );

    expect(result).toEqual({ success: true });
    expect(companyService.acceptNewClientInvitationLinkRequest).toHaveBeenCalledWith(
      "company-1",
      "cabinet-owner-1",
      "user-1",
    );
    expect(subscriptionService.syncMemberQuantity).toHaveBeenCalledWith(
      "company-1",
    );
  });
});
