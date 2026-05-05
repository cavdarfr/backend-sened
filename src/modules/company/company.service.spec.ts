import { ConflictException, ForbiddenException } from "@nestjs/common";
import { getSupabaseAdmin } from "../../config/supabase.config";
import {
  type CompanyOwnerRole,
  type CompanyRole,
} from "../../common/roles/roles";
import { CompanyService } from "./company.service";

jest.mock("../../config/supabase.config", () => ({
  getSupabaseAdmin: jest.fn(),
}));

function createDeleteSuccessChain() {
  const chain: any = {
    eq: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    is: jest.fn(() => chain),
    lt: jest.fn().mockResolvedValue({ error: null }),
    then: undefined,
  };

  return chain;
}

function createInviteSupabaseMock(options?: {
  existingUserId?: string;
  existingPendingInvite?: boolean;
  insertError?: { code?: string; message?: string };
}) {
  let insertedPayload: {
    company_id: string;
    email: string;
    role: CompanyRole;
    invited_by: string;
    invitation_type?: string;
    signup_company_name?: string | null;
    signup_siren?: string | null;
    signup_siret?: string | null;
    signup_address?: string | null;
    signup_postal_code?: string | null;
    signup_city?: string | null;
    signup_country?: string | null;
  } | null = null;
  const invitationUpdates: Record<string, any>[] = [];

  return {
    supabase: {
      from: jest.fn((table: string) => {
        if (table === "profiles") {
          return {
            select: jest.fn((columns: string) => {
              if (columns === "id") {
                return {
                  ilike: jest.fn().mockReturnValue({
                    maybeSingle: jest.fn().mockResolvedValue({
                      data: options?.existingUserId
                        ? { id: options.existingUserId }
                        : null,
                    }),
                  }),
                };
              }

              if (columns === "first_name, last_name") {
                return {
                  eq: jest.fn().mockReturnValue({
                    single: jest.fn().mockResolvedValue({
                      data: { first_name: "Jane", last_name: "Doe" },
                    }),
                  }),
                };
              }

              throw new Error(`Unexpected profiles select: ${columns}`);
            }),
          };
        }

        if (table === "company_invitations") {
          return {
            select: jest.fn((columns?: string) => {
              if (columns?.includes("company_id, email, role, token")) {
                return {
                  eq: jest.fn().mockReturnValue({
                    eq: jest.fn().mockReturnValue({
                      maybeSingle: jest.fn().mockResolvedValue({
                        data: {
                          id: "invite-1",
                          company_id: "company-1",
                          email: "member@example.com",
                          role: "merchant_consultant",
                          token: "token-1",
                          invited_by: "user-1",
                          expires_at: "2026-04-15T10:00:00.000Z",
                          invitation_type: "member",
                        },
                      }),
                    }),
                  }),
                };
              }

              return {
                eq: jest.fn().mockReturnValue({
                  ilike: jest.fn().mockReturnValue({
                    is: jest.fn().mockReturnValue({
                      gt: jest.fn().mockReturnValue({
                        maybeSingle: jest.fn().mockResolvedValue({
                          data: options?.existingPendingInvite
                            ? { id: "pending-invite-1" }
                            : null,
                        }),
                      }),
                      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
                    }),
                  }),
                }),
              };
            }),
            update: jest.fn((payload) => ({
              eq: jest.fn().mockImplementation(() => {
                invitationUpdates.push(payload);
                return Promise.resolve({ error: null });
              }),
            })),
            insert: jest.fn((payload) => {
              insertedPayload = payload;

              return {
                select: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: options?.insertError
                      ? null
                      : {
                          id: "invite-1",
                          token: "token-1",
                          email: payload.email,
                          role: payload.role,
                        },
                    error: options?.insertError || null,
                  }),
                }),
              };
            }),
            delete: jest.fn().mockReturnValue(createDeleteSuccessChain()),
          };
        }

        if (table === "companies") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    name: "Acme",
                    email: "contact@acme.test",
                    phone: "0102030405",
                    address: "1 rue Exemple",
                    postal_code: "75001",
                    city: "Paris",
                    siren: "123456789",
                    logo_url: "https://cdn.example.com/acme-logo.png",
                  },
                }),
              }),
            })),
          };
        }

        if (table === "user_companies") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({ data: null }),
                }),
              }),
            })),
            insert: jest.fn().mockResolvedValue({ error: null }),
            delete: jest.fn().mockReturnValue(createDeleteSuccessChain()),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    },
    getInsertedPayload: () => insertedPayload,
    getInvitationUpdates: () => invitationUpdates,
  };
}

function createResendInvitationSupabaseMock(invitation: any) {
  return {
    from: jest.fn((table: string) => {
      if (table === "company_invitations") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: invitation,
                  error: null,
                }),
              })),
            })),
          })),
        };
      }

      if (table === "companies") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  name: "Acme",
                  email: "contact@acme.test",
                  phone: "0102030405",
                  address: "1 rue Exemple",
                  postal_code: "75001",
                  city: "Paris",
                  siren: "123456789",
                  logo_url: "https://cdn.example.com/acme-logo.png",
                },
              }),
            }),
          })),
        };
      }

      if (table === "profiles") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { first_name: "Jane", last_name: "Doe" },
              }),
            }),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

function createCancelInvitationSupabaseMock(
  role: CompanyRole = "merchant_consultant",
) {
  return {
    from: jest.fn((table: string) => {
      if (table === "company_invitations") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    id: "invite-1",
                    company_id: "company-1",
                    email: "member@example.com",
                    role,
                    token: "token-1",
                    invited_by: "user-1",
                    expires_at: "2026-04-15T10:00:00.000Z",
                    invitation_type: "member",
                  },
                }),
              }),
            }),
          })),
          delete: jest.fn().mockReturnValue(createDeleteSuccessChain()),
          insert: jest.fn().mockResolvedValue({ error: null }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

function createExistingMerchantSupabaseMock(options?: {
  accountantCompanyId?: string | null;
  merchantCompanyId?: string;
  merchantCompanyName?: string;
  hasMerchantAdmin?: boolean;
  hasPendingRequest?: boolean;
}) {
  const merchantCompanyId = options?.merchantCompanyId || "merchant-1";

  return {
    from: jest.fn((table: string) => {
      if (table === "companies") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    id: merchantCompanyId,
                    name: options?.merchantCompanyName || "Marchand existant",
                    siren: "123456789",
                    accountant_company_id:
                      options?.accountantCompanyId ?? null,
                  },
                  error: null,
                }),
              }),
            }),
          })),
        };
      }

      if (table === "user_companies") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn().mockResolvedValue({
              data: options?.hasMerchantAdmin === false
                ? []
                : [{ company_id: merchantCompanyId }],
              error: null,
            }),
          })),
        };
      }

      if (table === "accountant_link_requests") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: options?.hasPendingRequest ? { id: "request-1" } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

describe("CompanyService member management permissions", () => {
  let service: CompanyService;
  let notificationService: { sendInviteEmail: jest.Mock };
  let subscriptionService: {
    syncMemberQuantity: jest.Mock;
    isMemberQuantityBillingSettled: jest.Mock;
  };
  const originalRootSuperadminEmail = process.env.SUPERADMIN_ROOT_EMAIL;

  beforeEach(() => {
    notificationService = {
      sendInviteEmail: jest.fn().mockResolvedValue(undefined),
    };
    subscriptionService = {
      syncMemberQuantity: jest.fn().mockResolvedValue(undefined),
      isMemberQuantityBillingSettled: jest.fn().mockResolvedValue(true),
    };

    service = new CompanyService(
      { notifyCompanyCreated: jest.fn() } as any,
      notificationService as any,
      subscriptionService as any,
    );

    jest.mocked(getSupabaseAdmin).mockReset();
  });

  afterEach(() => {
    if (originalRootSuperadminEmail === undefined) {
      delete process.env.SUPERADMIN_ROOT_EMAIL;
    } else {
      process.env.SUPERADMIN_ROOT_EMAIL = originalRootSuperadminEmail;
    }

    jest.restoreAllMocks();
  });

  function mockUserRole(role: CompanyRole) {
    return jest
      .spyOn(service as any, "checkUserAccess")
      .mockResolvedValue(role);
  }

  function mockUserAccessContext(
    role: CompanyRole,
    companyOwnerRole: CompanyOwnerRole,
  ) {
    return jest
      .spyOn(service as any, "checkUserAccessContext")
      .mockResolvedValue({
        role,
        companyOwnerRole,
        companyOwnerId: "owner-1",
        isCabinet: companyOwnerRole === "accountant",
        isMerchantCompany: companyOwnerRole === "merchant_admin",
      });
  }

  it.each(["merchant_admin", "merchant_consultant"] as CompanyRole[])(
    "allows merchant_admin to invite the %s role",
    async (invitedRole) => {
      const inviteMock = createInviteSupabaseMock();

      jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
      mockUserAccessContext("merchant_admin", "merchant_admin");

      const result = await service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        invitedRole,
        "admin@example.com",
      );

      expect(result.status).toBe("pending");
      expect(inviteMock.getInsertedPayload()).toMatchObject({
        company_id: "company-1",
        email: "member@example.com",
        role: invitedRole,
        invited_by: "user-1",
      });
      expect(notificationService.sendInviteEmail).toHaveBeenCalledWith(
        "member@example.com",
        "Jane Doe",
        expect.objectContaining({
          logo_url: "https://cdn.example.com/acme-logo.png",
        }),
        invitedRole,
        "token-1",
      );
      expect(subscriptionService.syncMemberQuantity).toHaveBeenCalledWith(
        "company-1",
      );
    },
  );

  it("does not roll back a pending merchant invitation when SEPA member sync succeeds", async () => {
    const inviteMock = createInviteSupabaseMock();
    const rollbackSpy = jest
      .spyOn(service as any, "rollbackPendingMemberInvitation")
      .mockResolvedValue(undefined);

    subscriptionService.syncMemberQuantity.mockResolvedValue(undefined);

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("merchant_admin", "merchant_admin");

    const result = await service.inviteMember(
      "user-1",
      "company-1",
      "member@example.com",
      "merchant_consultant",
      "admin@example.com",
    );

    expect(result.status).toBe("pending");
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it("keeps a merchant invitation blocked and unsent when member billing requires payment confirmation", async () => {
    const inviteMock = createInviteSupabaseMock();

    subscriptionService.syncMemberQuantity.mockResolvedValue({
      client_secret: "pi_secret_123",
      status: "active",
    });

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("merchant_admin", "merchant_admin");

    const result = await service.inviteMember(
      "user-1",
      "company-1",
      "member@example.com",
      "merchant_consultant",
      "admin@example.com",
    );

    expect(result).toMatchObject({
      status: "payment_required",
      billing_status: "payment_required",
      client_secret: "pi_secret_123",
    });
    expect(inviteMock.getInsertedPayload()).toMatchObject({
      billing_status: "settled",
    });
    expect(inviteMock.getInvitationUpdates()).toContainEqual({
      billing_status: "payment_required",
    });
    expect(notificationService.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects duplicate pending invitations with a business error", async () => {
    const inviteMock = createInviteSupabaseMock({ existingPendingInvite: true });

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "merchant_consultant",
        "admin@example.com",
      ),
    ).rejects.toThrow(
      new ConflictException("Une invitation est déjà en attente pour cet email"),
    );

    expect(inviteMock.getInsertedPayload()).toBeNull();
  });

  it("maps unique invitation constraint errors to a business error", async () => {
    const inviteMock = createInviteSupabaseMock({
      insertError: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "uq_company_invitations_company_email_lower"',
      },
    });

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "merchant_consultant",
        "admin@example.com",
      ),
    ).rejects.toThrow(
      new ConflictException("Une invitation est déjà en attente pour cet email"),
    );
  });

  it.each(["accountant", "accountant_consultant"] as CompanyRole[])(
    "rejects merchant_admin invitation for %s in a merchant company",
    async (invitedRole) => {
      jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
      mockUserAccessContext("merchant_admin", "merchant_admin");

      await expect(
        service.inviteMember(
          "user-1",
          "company-1",
          "member@example.com",
          invitedRole,
          "admin@example.com",
        ),
      ).rejects.toThrow(
        new ForbiddenException(
          "Rôle d’invitation non autorisé pour cette entreprise",
        ),
      );
    },
  );

  it("rolls back a pending merchant invitation when billing sync fails", async () => {
    const inviteMock = createInviteSupabaseMock();
    const rollbackSpy = jest
      .spyOn(service as any, "rollbackPendingMemberInvitation")
      .mockResolvedValue(undefined);

    subscriptionService.syncMemberQuantity.mockRejectedValue(
      new Error("Stripe sync failed"),
    );

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "merchant_consultant",
        "admin@example.com",
      ),
    ).rejects.toThrow(
      "L'ajout du membre n'a pas pu être finalisé car la mise à jour de la facturation a échoué.",
    );

    expect(rollbackSpy).toHaveBeenCalledWith(inviteMock.supabase, "invite-1");
    expect(notificationService.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("allows accountant to invite cabinet members in a cabinet", async () => {
    const inviteMock = createInviteSupabaseMock();

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("accountant", "accountant");

    const result = await service.inviteMember(
      "user-1",
      "company-1",
      "member@example.com",
      "accountant_consultant",
      "accountant@example.com",
    );

    expect(result.status).toBe("pending");
    expect(inviteMock.getInsertedPayload()).toMatchObject({
      role: "accountant_consultant",
    });
  });

  it("allows accountant to invite a merchant_admin for a linked client", async () => {
    const inviteMock = createInviteSupabaseMock();

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserRole("accountant");
    jest
      .spyOn(service as any, "assertLinkedClientForAccountant")
      .mockResolvedValue(undefined);

    const result = await service.inviteLinkedClientMerchantAdmin(
      "user-1",
      "cabinet-1",
      "client-1",
      "merchant-admin@example.com",
    );

    expect(result.status).toBe("pending");
    expect(inviteMock.getInsertedPayload()).toMatchObject({
      company_id: "client-1",
      email: "merchant-admin@example.com",
      role: "merchant_admin",
      invited_by: "user-1",
    });
    expect(notificationService.sendInviteEmail).toHaveBeenCalledWith(
      "merchant-admin@example.com",
      "Jane Doe",
      expect.objectContaining({
        name: "Acme",
      }),
      "merchant_admin",
      "token-1",
    );
    expect(subscriptionService.syncMemberQuantity).toHaveBeenCalledWith(
      "client-1",
    );
  });

  it("invites a new merchant admin with a merchant signup invitation and no provisional company", async () => {
    const inviteMock = createInviteSupabaseMock();

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserRole("accountant");
    jest
      .spyOn(service as any, "findExistingMerchantCompanyForInvite")
      .mockResolvedValue(null);

    const result = await service.inviteNewMerchantAdmin("user-1", "cabinet-1", {
      email: "merchant-admin@example.com",
      company_name: "Nouveau Marchand",
      siren: "123 456 789",
      siret: "123 456 789 00012",
      address: "1 rue Exemple",
      postal_code: "75001",
      city: "Paris",
      country: "fr",
    });

    expect(result).toEqual({
      status: "invited",
      invitation_id: "invite-1",
      email: "merchant-admin@example.com",
    });
    expect(inviteMock.getInsertedPayload()).toMatchObject({
      company_id: "cabinet-1",
      email: "merchant-admin@example.com",
      role: "merchant_admin",
      invited_by: "user-1",
      invitation_type: "merchant_signup",
      signup_company_name: "Nouveau Marchand",
      signup_siren: "123456789",
      signup_siret: "12345678900012",
      signup_address: "1 rue Exemple",
      signup_postal_code: "75001",
      signup_city: "Paris",
      signup_country: "FR",
    });
    expect(notificationService.sendInviteEmail).toHaveBeenCalledWith(
      "merchant-admin@example.com",
      "Jane Doe",
      expect.objectContaining({
        name: "Acme",
      }),
      "merchant_admin",
      "token-1",
    );
  });

  it("returns an existing merchant when the SIREN already matches an eligible platform merchant", async () => {
    jest
      .mocked(getSupabaseAdmin)
      .mockReturnValue(createExistingMerchantSupabaseMock() as any);
    mockUserRole("accountant");
    const inviteSpy = jest.spyOn(service as any, "createMerchantSignupInvitation");

    const result = await service.inviteNewMerchantAdmin("user-1", "cabinet-1", {
      email: "merchant-admin@example.com",
      company_name: "Marchand existant",
      siren: "123456789",
    });

    expect(result).toEqual({
      status: "existing_merchant",
      merchant_company: {
        id: "merchant-1",
        name: "Marchand existant",
        siren: "123456789",
      },
    });
    expect(inviteSpy).not.toHaveBeenCalled();
  });

  it("rejects a new merchant invite when the matching company is already linked to another cabinet", async () => {
    jest
      .mocked(getSupabaseAdmin)
      .mockReturnValue(
        createExistingMerchantSupabaseMock({
          accountantCompanyId: "cabinet-2",
        }) as any,
      );
    mockUserRole("accountant");

    await expect(
      service.inviteNewMerchantAdmin("user-1", "cabinet-1", {
        email: "merchant-admin@example.com",
        company_name: "Marchand existant",
        siren: "123456789",
      }),
    ).rejects.toThrow("Cette entreprise est déjà liée à un autre cabinet");
  });

  it("rejects linked client merchant admin invitations for accountant_consultant", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserRole("accountant_consultant");

    await expect(
      service.inviteLinkedClientMerchantAdmin(
        "user-1",
        "cabinet-1",
        "client-1",
        "merchant-admin@example.com",
      ),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul un expert-comptable administrateur peut gérer les invitations admin marchand de ce dossier client",
      ),
    );
  });

  it("rejects linked client merchant admin invitations when the client is not linked", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserRole("accountant");
    jest
      .spyOn(service as any, "assertLinkedClientForAccountant")
      .mockRejectedValue(
        new Error("Client non trouvé ou non lié à votre cabinet"),
      );

    await expect(
      service.inviteLinkedClientMerchantAdmin(
        "user-1",
        "cabinet-1",
        "client-1",
        "merchant-admin@example.com",
      ),
    ).rejects.toThrow("Client non trouvé ou non lié à votre cabinet");
  });

  it("rejects new merchant invitations for accountant_consultant", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserRole("accountant_consultant");

    await expect(
      service.inviteNewMerchantAdmin("user-1", "cabinet-1", {
        email: "merchant-admin@example.com",
        company_name: "Nouveau Marchand",
        siren: "123456789",
      }),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul un expert-comptable administrateur peut inviter un nouveau commerçant depuis ce cabinet",
      ),
    );
  });

  it("lists pending merchant_admin invitations for a linked client", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === "company_invitations") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    is: jest.fn().mockReturnValue({
                      gt: jest.fn().mockReturnValue({
                        order: jest.fn().mockResolvedValue({
                          data: [
                            {
                              id: "invite-1",
                              email: "merchant-admin@example.com",
                              role: "merchant_admin",
                              created_at: "2026-04-10T09:00:00.000Z",
                              expires_at: "2026-04-17T09:00:00.000Z",
                            },
                          ],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any);
    mockUserRole("accountant");
    jest
      .spyOn(service as any, "assertLinkedClientForAccountant")
      .mockResolvedValue(undefined);

    await expect(
      service.getLinkedClientMerchantAdminInvitations(
        "user-1",
        "cabinet-1",
        "client-1",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "invite-1",
        email: "merchant-admin@example.com",
        role: "merchant_admin",
      }),
    ]);
  });

  it("does not sync billing when a cabinet invitation is auto-accepted", async () => {
    const inviteMock = createInviteSupabaseMock({ existingUserId: "member-1" });

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("accountant", "accountant");

    const result = await service.inviteMember(
      "user-1",
      "company-1",
      "member@example.com",
      "accountant_consultant",
      "accountant@example.com",
    );

    expect(result.status).toBe("accepted");
    expect(subscriptionService.syncMemberQuantity).not.toHaveBeenCalled();
  });

  it("rejects cabinet invitations for accountant_consultant", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserAccessContext("accountant_consultant", "accountant");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "accountant_consultant",
        "collaborator@example.com",
      ),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul l’expert-comptable administrateur peut gérer les membres de ce cabinet",
      ),
    );
  });

  it("allows the configured root superadmin to invite a superadmin", async () => {
    process.env.SUPERADMIN_ROOT_EMAIL = "root@example.com";

    const inviteMock = createInviteSupabaseMock();

    jest.mocked(getSupabaseAdmin).mockReturnValue(inviteMock.supabase as any);
    mockUserAccessContext("superadmin", "merchant_admin");

    const result = await service.inviteMember(
      "user-1",
      "company-1",
      "member@example.com",
      "superadmin",
      "ROOT@example.com",
    );

    expect(result.status).toBe("pending");
    expect(inviteMock.getInsertedPayload()).toMatchObject({
      role: "superadmin",
    });
  });

  it("rejects superadmin invitations from a non-root merchant admin", async () => {
    process.env.SUPERADMIN_ROOT_EMAIL = "root@example.com";

    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "superadmin",
        "admin@example.com",
      ),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul le compte superadmin racine peut inviter un superadmin",
      ),
    );
  });

  it("rejects superadmin invitations from a non-root superadmin", async () => {
    process.env.SUPERADMIN_ROOT_EMAIL = "root@example.com";

    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserAccessContext("superadmin", "merchant_admin");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "superadmin",
        "other-superadmin@example.com",
      ),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul le compte superadmin racine peut inviter un superadmin",
      ),
    );
  });

  it("rejects superadmin invitations when the root email is not configured", async () => {
    delete process.env.SUPERADMIN_ROOT_EMAIL;

    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserAccessContext("superadmin", "merchant_admin");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "superadmin",
        "root@example.com",
      ),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul le compte superadmin racine peut inviter un superadmin",
      ),
    );
  });

  it("rejects merchant roles when inviting in a cabinet", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserAccessContext("accountant", "accountant");

    await expect(
      service.inviteMember(
        "user-1",
        "company-1",
        "member@example.com",
        "merchant_consultant",
        "accountant@example.com",
      ),
    ).rejects.toThrow(
      new ForbiddenException(
        "Un cabinet ne peut inviter que des experts-comptables ou des collaborateurs comptables",
      ),
    );
  });

  it("allows merchant_admin to remove a member", async () => {
    const deleteChain = createDeleteSuccessChain();

    jest.mocked(getSupabaseAdmin).mockReturnValue({
      from: jest.fn(() => ({
        delete: jest.fn().mockReturnValue(deleteChain),
      })),
    } as any);
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.removeMember("admin-1", "company-1", "member-1"),
    ).resolves.toEqual({ message: "Membre retiré avec succès" });

    expect(subscriptionService.syncMemberQuantity).toHaveBeenCalledWith(
      "company-1",
    );
  });

  it("allows accountant to remove a cabinet member without syncing billing", async () => {
    const deleteChain = createDeleteSuccessChain();

    jest.mocked(getSupabaseAdmin).mockReturnValue({
      from: jest.fn(() => ({
        delete: jest.fn().mockReturnValue(deleteChain),
      })),
    } as any);
    mockUserAccessContext("accountant", "accountant");

    await expect(
      service.removeMember("user-1", "company-1", "member-1"),
    ).resolves.toEqual({ message: "Membre retiré avec succès" });

    expect(subscriptionService.syncMemberQuantity).not.toHaveBeenCalled();
  });

  it("rejects member removal for accountant_consultant in a cabinet", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserAccessContext("accountant_consultant", "accountant");

    await expect(
      service.removeMember("user-1", "company-1", "member-1"),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul l’expert-comptable administrateur peut gérer les membres de ce cabinet",
      ),
    );
  });

  it("allows merchant_admin to cancel an invitation", async () => {
    jest
      .mocked(getSupabaseAdmin)
      .mockReturnValue(createCancelInvitationSupabaseMock());
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.cancelInvitation("admin-1", "company-1", "invite-1"),
    ).resolves.toEqual({ message: "Invitation annulée" });

    expect(subscriptionService.syncMemberQuantity).toHaveBeenCalledWith(
      "company-1",
    );
  });

  it("resends a pending member invitation", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue(
      createResendInvitationSupabaseMock({
        id: "invite-1",
        company_id: "company-1",
        email: "member@example.com",
        role: "merchant_consultant",
        token: "token-1",
        expires_at: "2099-04-15T10:00:00.000Z",
        accepted_at: null,
        invitation_type: "member",
      }) as any,
    );
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.resendMemberInvitation("admin-1", "company-1", "invite-1"),
    ).resolves.toEqual({ message: "Invitation renvoyée" });

    expect(notificationService.sendInviteEmail).toHaveBeenCalledWith(
      "member@example.com",
      "Jane Doe",
      expect.objectContaining({ name: "Acme" }),
      "merchant_consultant",
      "token-1",
    );
  });

  it("rejects resending an accepted member invitation", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue(
      createResendInvitationSupabaseMock({
        id: "invite-1",
        company_id: "company-1",
        email: "member@example.com",
        role: "merchant_consultant",
        token: "token-1",
        expires_at: "2099-04-15T10:00:00.000Z",
        accepted_at: "2026-04-15T10:00:00.000Z",
        invitation_type: "member",
      }) as any,
    );
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.resendMemberInvitation("admin-1", "company-1", "invite-1"),
    ).rejects.toThrow("Cette invitation a déjà été acceptée");

    expect(notificationService.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects resending an expired member invitation", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue(
      createResendInvitationSupabaseMock({
        id: "invite-1",
        company_id: "company-1",
        email: "member@example.com",
        role: "merchant_consultant",
        token: "token-1",
        expires_at: "2000-04-15T10:00:00.000Z",
        accepted_at: null,
        invitation_type: "member",
      }) as any,
    );
    mockUserAccessContext("merchant_admin", "merchant_admin");

    await expect(
      service.resendMemberInvitation("admin-1", "company-1", "invite-1"),
    ).rejects.toThrow("Cette invitation a expiré");

    expect(notificationService.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("allows accountant to cancel a cabinet invitation", async () => {
    jest
      .mocked(getSupabaseAdmin)
      .mockReturnValue(
        createCancelInvitationSupabaseMock("accountant_consultant"),
      );
    mockUserAccessContext("accountant", "accountant");

    await expect(
      service.cancelInvitation("user-1", "company-1", "invite-1"),
    ).resolves.toEqual({ message: "Invitation annulée" });
  });

  it("allows accountant to cancel a linked client merchant_admin invitation", async () => {
    jest
      .mocked(getSupabaseAdmin)
      .mockReturnValue(createCancelInvitationSupabaseMock("merchant_admin"));
    mockUserRole("accountant");
    jest
      .spyOn(service as any, "assertLinkedClientForAccountant")
      .mockResolvedValue(undefined);

    await expect(
      service.cancelLinkedClientMerchantAdminInvitation(
        "user-1",
        "cabinet-1",
        "client-1",
        "invite-1",
      ),
    ).resolves.toEqual({ message: "Invitation annulée" });

    expect(subscriptionService.syncMemberQuantity).toHaveBeenCalledWith(
      "client-1",
    );
  });

  it("rejects invitation cancellation for accountant_consultant in a cabinet", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({ from: jest.fn() } as any);
    mockUserAccessContext("accountant_consultant", "accountant");

    await expect(
      service.cancelInvitation("user-1", "company-1", "invite-1"),
    ).rejects.toThrow(
      new ForbiddenException(
        "Seul l’expert-comptable administrateur peut gérer les membres de ce cabinet",
      ),
    );
  });

  it("includes invited firm data when validating an accountant firm invitation", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === "company_invitations") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  is: jest.fn().mockReturnValue({
                    gt: jest.fn().mockReturnValue({
                      maybeSingle: jest.fn().mockResolvedValue({
                        data: {
                          company_id: "merchant-1",
                          email: "cabinet@example.com",
                          role: "accountant",
                          invitation_type: "accountant_firm",
                          expires_at: "2026-04-15T10:00:00.000Z",
                          invited_by: "user-1",
                          invited_firm_name: "Cabinet Test",
                          invited_firm_siren: "123456789",
                          company: { name: "Entreprise Test" },
                        },
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            })),
          };
        }

        if (table === "profiles") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: { first_name: "Jane", last_name: "Doe" },
                }),
              }),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any);

    await expect(service.validateInviteToken("token-1")).resolves.toMatchObject(
      {
        company_id: "merchant-1",
        email: "cabinet@example.com",
        role: "accountant",
        invitation_type: "accountant_firm",
        company_name: "Entreprise Test",
        inviter_name: "Jane Doe",
        invited_firm_name: "Cabinet Test",
        invited_firm_siren: "123456789",
      },
    );
  });

  it("includes merchant signup draft data when validating a merchant signup invitation", async () => {
    jest.mocked(getSupabaseAdmin).mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === "company_invitations") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  is: jest.fn().mockReturnValue({
                    gt: jest.fn().mockReturnValue({
                      maybeSingle: jest.fn().mockResolvedValue({
                        data: {
                          company_id: "cabinet-1",
                          email: "merchant@example.com",
                          role: "merchant_admin",
                          invitation_type: "merchant_signup",
                          expires_at: "2026-04-15T10:00:00.000Z",
                          invited_by: "user-1",
                          signup_company_name: "Marchand Test",
                          signup_siren: "123456789",
                          signup_siret: "12345678900012",
                          signup_address: "1 rue Exemple",
                          signup_postal_code: "75001",
                          signup_city: "Paris",
                          signup_country: "FR",
                          company: { name: "Cabinet Test" },
                        },
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            })),
          };
        }

        if (table === "profiles") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: { first_name: "Jane", last_name: "Doe" },
                }),
              }),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any);

    await expect(service.validateInviteToken("token-1")).resolves.toMatchObject(
      {
        company_id: "cabinet-1",
        email: "merchant@example.com",
        role: "merchant_admin",
        invitation_type: "merchant_signup",
        company_name: "Cabinet Test",
        inviter_name: "Jane Doe",
        signup_company_name: "Marchand Test",
        signup_siren: "123456789",
        signup_siret: "12345678900012",
        signup_address: "1 rue Exemple",
        signup_postal_code: "75001",
        signup_city: "Paris",
        signup_country: "FR",
      },
    );
  });

  it("maps accountant document storage availability on linked client documents", async () => {
    const invoices = [
      {
        id: "invoice-1",
        invoice_number: "F-2026-001",
        total: 1200,
        status: "paid",
        issue_date: "2026-02-10",
        created_at: "2026-02-10T10:00:00.000Z",
        type: "standard",
      },
      {
        id: "invoice-2",
        invoice_number: "F-2026-002",
        total: 850,
        status: "sent",
        issue_date: "2026-02-20",
        created_at: "2026-02-20T10:00:00.000Z",
        type: "standard",
      },
    ];

    jest.mocked(getSupabaseAdmin).mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === "companies") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: { id: "client-1" },
                    error: null,
                  }),
                }),
              }),
            })),
          };
        }

        if (table === "invoices") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  gte: jest.fn().mockReturnValue({
                    lte: jest.fn().mockReturnValue({
                      neq: jest.fn().mockReturnValue({
                        order: jest.fn().mockResolvedValue({
                          data: invoices,
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            })),
          };
        }

        if (table === "documents") {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    in: jest.fn().mockReturnValue({
                      order: jest.fn().mockResolvedValue({
                        data: [
                          {
                            id: "stored-1",
                            related_id: "invoice-1",
                            filename: "facture-F-2026-001.pdf",
                            storage_path:
                              "client-1/invoices/invoice-1/facture-F-2026-001.pdf",
                            mime_type: "application/pdf",
                            created_at: "2026-02-10T11:00:00.000Z",
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            })),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any);
    mockUserRole("accountant");

    const result = await service.getLinkedClientDocuments(
      "user-1",
      "cabinet-1",
      "client-1",
      { type: "invoices", year: 2026, period: "q1", page: 1, limit: 20 },
    );

    expect(result.total).toBe(2);
    expect(result.data).toEqual([
      expect.objectContaining({
        id: "invoice-1",
        document_kind: "invoice",
        is_immutable: true,
        storage_available: true,
        stored_document_id: "stored-1",
        downloadable_filename: "facture-F-2026-001.pdf",
      }),
      expect.objectContaining({
        id: "invoice-2",
        document_kind: "invoice",
        is_immutable: true,
        storage_available: false,
        stored_document_id: null,
        downloadable_filename: "facture-F-2026-002.pdf",
      }),
    ]);
  });
});
