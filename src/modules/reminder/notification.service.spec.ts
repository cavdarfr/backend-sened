import { ConfigService } from "@nestjs/config";
import { NotificationService } from "./notification.service";

describe("NotificationService email rendering", () => {
  let service: NotificationService;
  let configService: { get: jest.Mock };

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string, defaultValue?: string) => {
        if (key === "FRONTEND_URL") return "https://app.example.com";
        return defaultValue;
      }),
    };

    service = new NotificationService(
      configService as unknown as ConfigService,
    );
    jest.spyOn(service, "sendEmail").mockResolvedValue({ success: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders justified copy in quote V2 emails", async () => {
    await service.sendQuoteEmailV2(
      {
        quote_number: "D-2026-001",
        total: 1250,
        issue_date: "2026-04-07",
        validity_date: "2026-04-30",
        subject: "Prestation annuelle",
        signature_token: "quote-token",
        signature_provider: "internal",
        terms_and_conditions: "CGV de test",
      },
      {
        email: "client@example.com",
        company_name: "Client Test",
      },
      {
        name: "SENED",
        email: "contact@sened.fr",
        logo_url: "https://cdn.example.com/sened-logo.png",
      },
    );

    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("text-align: justify"),
      }),
    );
    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("header-logo-table"),
      }),
    );
    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("https://cdn.example.com/sened-logo.png"),
      }),
    );
  });

  it("keeps credit notes on the invoice flow with the avoir attachment prefix", async () => {
    const pdfBuffer = Buffer.from("pdf");

    await service.sendInvoiceEmailV2(
      {
        invoice_number: "AV-2026-001",
        type: "credit_note",
        total: -150,
        issue_date: "2026-04-07",
        due_date: "2026-04-07",
        subject: "Régularisation",
        signature_token: "invoice-token",
        payment_link: "https://pay.example.com",
      },
      {
        email: "client@example.com",
        company_name: "Client Test",
      },
      {
        name: "SENED",
        email: "contact@sened.fr",
        logo_url: "https://cdn.example.com/sened-logo.png",
      },
      pdfBuffer,
    );

    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("Avoir"),
        html: expect.stringContaining("Montant de l'avoir"),
        attachments: [
          expect.objectContaining({
            filename: "avoir-AV-2026-001.pdf",
            content: pdfBuffer,
          }),
        ],
      }),
    );
    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("header-logo-table"),
      }),
    );
  });

  it("renders SENED fallback only in invite emails without a company logo", async () => {
    await service.sendInviteEmail(
      "invitee@example.com",
      "Alice Martin",
      {
        name: "SENED",
        email: "contact@sened.fr",
        address: "10 rue de Paris",
        postal_code: "75001",
        city: "Paris",
        siren: "123456789",
      },
      "merchant_admin",
      "invite-token",
    );

    const sentEmail = jest.mocked(service.sendEmail).mock.calls[0]?.[0];

    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Invitation à rejoindre SENED",
      }),
    );
    expect(sentEmail?.html).toContain("header-branding-table");
    expect(sentEmail?.html).toContain('aria-label="SENED"');
    expect(sentEmail?.html).not.toContain(
      'class="header-logo-cell header-company-logo-cell"',
    );
    expect(sentEmail?.html).not.toContain('header-brand-divider-cell"');
    expect(sentEmail?.html).not.toContain("<img src=");
  });

  it("renders SENED and the inviter company logo in invite emails when available", async () => {
    await service.sendInviteEmail(
      "invitee@example.com",
      "Alice Martin",
      {
        name: "Acme",
        email: "contact@acme.test",
        address: "10 rue de Paris",
        postal_code: "75001",
        city: "Paris",
        siren: "123456789",
        logo_url: "https://cdn.example.com/acme-logo.png",
      },
      "merchant_admin",
      "invite-token",
    );

    const sentEmail = jest.mocked(service.sendEmail).mock.calls[0]?.[0];

    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Invitation à rejoindre Acme",
      }),
    );
    expect(sentEmail?.html).toContain("header-branding-table");
    expect(sentEmail?.html).toContain('aria-label="SENED"');
    expect(sentEmail?.html).toContain("https://cdn.example.com/acme-logo.png");
    expect(sentEmail?.html).toContain("header-brand-divider-cell");
    expect(sentEmail?.html).toContain("header-company-logo-cell");
  });

  it("renders merchant admin invite emails with the administrator label and register URL", async () => {
    await service.sendInviteEmail(
      "invitee@example.com",
      "Alice Martin",
      {
        name: "Client Marchand",
        email: "contact@client.test",
        address: "10 rue de Paris",
        postal_code: "75001",
        city: "Paris",
        siren: "123456789",
      },
      "merchant_admin",
      "invite-token",
    );

    const sentEmail = jest.mocked(service.sendEmail).mock.calls[0]?.[0];

    expect(sentEmail?.subject).toBe("Invitation à rejoindre Client Marchand");
    expect(sentEmail?.html).toContain("Administrateur");
    expect(sentEmail?.html).toContain(
      "https://app.example.com/auth/register?invite=invite-token",
    );
    expect(sentEmail?.text).toContain("Administrateur");
  });

  it("renders the shared header wrapper in payment confirmation emails when a logo is available", async () => {
    await service.sendPaymentConfirmationEmail(
      {
        invoice_number: "FAC-2026-001",
        total: 420,
        signature_token: "invoice-token",
      },
      {
        email: "client@example.com",
        company_name: "Client Test",
      },
      {
        name: "Acme",
        email: "contact@acme.test",
        logo_url: "https://cdn.example.com/acme-logo.png",
      },
      "Carte bancaire",
      "txn_123",
    );

    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("header-logo-table"),
      }),
    );
    expect(service.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("https://cdn.example.com/acme-logo.png"),
      }),
    );
  });

  it("renders the shared fallback header in welcome emails without a company logo", async () => {
    await service.sendWelcomeEmail(
      {
        email: "user@example.com",
        first_name: "Alice",
      },
      {
        name: "Acme",
        email: "contact@acme.test",
      },
    );

    const sentEmail = jest.mocked(service.sendEmail).mock.calls[0]?.[0];

    expect(sentEmail?.html).toContain("header-logo-table");
    expect(sentEmail?.html).toContain("header-logo-fallback-cell");
    expect(sentEmail?.html).toContain('aria-label="SENED"');
  });
});
