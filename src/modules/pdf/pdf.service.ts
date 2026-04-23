import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as puppeteer from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import { PDFDocument } from "pdf-lib";
import { getSupabaseAdmin } from "../../config/supabase.config";

// Types pour Factur-X
export enum FacturXProfile {
  MINIMUM = "minimum",
  BASIC_WL = "basicwl",
  BASIC = "basic",
  EN16931 = "en16931",
  EXTENDED = "extended",
}

export interface InvoiceData {
  // Informations facture
  invoice_number: string;
  issue_date: string;
  due_date: string;
  type: "standard" | "deposit" | "final" | "credit";

  // Totaux
  subtotal: number;
  total_vat: number;
  total: number;
  amount_paid: number;
  discount_type?: string;
  discount_value?: number;

  // Entreprise émettrice
  company: {
    name: string;
    legal_name?: string;
    siren: string;
    vat_number?: string;
    address: string;
    postal_code: string;
    city: string;
    country?: string;
    phone?: string;
    email?: string;
    logo_url?: string;
    rib_iban?: string;
    rib_bic?: string;
    rib_bank_name?: string;
    is_vat_exempt?: boolean;
    vat_exemption_note?: string;
  };

  // Client
  client: {
    company_name?: string;
    first_name?: string;
    last_name?: string;
    siren?: string;
    siret?: string;
    vat_number?: string;
    address: string;
    postal_code: string;
    city: string;
    country?: string;
    email?: string;
  };

  // Lignes
  items: Array<{
    reference?: string;
    description: string;
    quantity: number;
    unit?: string;
    unit_price: number;
    vat_rate: number;
    discount_type?: string;
    discount_value?: number;
    line_total: number;
  }>;

  // Métadonnées
  notes?: string;
  title?: string;
  conditions?: string;
  facturx_profile?: FacturXProfile;
}

export interface QuoteData {
  quote_number: string;
  issue_date: string;
  validity_date: string;

  subtotal: number;
  total_vat: number;
  total: number;
  discount_type?: string;
  discount_value?: number;

  company: InvoiceData["company"];
  client: InvoiceData["client"];
  items: InvoiceData["items"];

  notes?: string;
  title?: string;
  conditions?: string;
}

interface StoredDocumentRecord {
  id: string;
  company_id: string | null;
  uploaded_by: string;
  type: "invoice_pdf";
  related_type: string | null;
  related_id: string | null;
  filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  expires_at: string;
  created_at: string;
}

export interface StoredInvoicePdfResult {
  buffer: Buffer;
  documentId: string | null;
  storagePath: string | null;
  fromStorage: boolean;
}

const PLATFORM_FOOTER_BRAND_NAME = "Sened";

@Injectable()
export class PdfService implements OnModuleDestroy {
  private browser: puppeteer.Browser | null = null;
  private readonly logger = new Logger(PdfService.name);
  private readonly documentsBucket: string;
  private platformFooterLogoDataUri: string | null | undefined;
  private readonly platformFooterLogoPath = path.join(
    __dirname,
    "..",
    "..",
    "brand",
    "SECONDAIRE_bleu.svg",
  );

  constructor(private readonly configService: ConfigService) {
    this.documentsBucket = this.configService.get(
      "STORAGE_DOCUMENTS_BUCKET",
      "documents",
    );
  }

  /**
   * Ferme le navigateur lors de l'arrêt du module
   */
  async onModuleDestroy() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        // Ignore les erreurs de fermeture
      }
      this.browser = null;
    }
  }

  /**
   * Vérifie si le navigateur est encore connecté
   */
  private isBrowserConnected(): boolean {
    return this.browser !== null && this.browser.connected;
  }

  /**
   * Initialise le navigateur Puppeteer
   */
  private async getBrowser(): Promise<puppeteer.Browser> {
    if (!this.isBrowserConnected()) {
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (e) {
          // Ignore les erreurs de fermeture
        }
      }
      this.browser = await puppeteer.launch({
        headless: true,
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH &&
          fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
            ? process.env.PUPPETEER_EXECUTABLE_PATH
            : undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    }
    return this.browser!;
  }

  /**
   * Formate un nombre en euros
   */
  private formatCurrency(amount: number): string {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
    }).format(amount);
  }

  /**
   * Formate une date
   */
  private formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(date);
  }

  private resolveCompanyLogoUrl(logoUrl?: string | null): string | null {
    const normalizedLogoUrl = logoUrl?.trim();
    return normalizedLogoUrl ? normalizedLogoUrl : null;
  }

  private getPlatformFooterLogoDataUri(): string | null {
    if (this.platformFooterLogoDataUri !== undefined) {
      return this.platformFooterLogoDataUri;
    }

    try {
      const logoSvg = fs.readFileSync(this.platformFooterLogoPath, "utf8");
      this.platformFooterLogoDataUri = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
        logoSvg,
      )}`;
    } catch (error) {
      this.logger.warn(
        `Impossible de charger le logo de marque PDF depuis ${this.platformFooterLogoPath}`,
      );
      this.platformFooterLogoDataUri = null;
    }

    return this.platformFooterLogoDataUri;
  }

  private renderPlatformFooterBranding(): string {
    const platformFooterLogoDataUri = this.getPlatformFooterLogoDataUri();

    return `
        <div class="footer-branding">
            ${
              platformFooterLogoDataUri
                ? `<img src="${platformFooterLogoDataUri}" class="footer-branding-logo" alt="${PLATFORM_FOOTER_BRAND_NAME}">`
                : ""
            }
            <span>Document généré par ${PLATFORM_FOOTER_BRAND_NAME}</span>
        </div>`;
  }

  formatInvoiceForPdf(invoice: any): InvoiceData {
    return {
      invoice_number: invoice.invoice_number,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      type:
        invoice.type === "credit_note" ? "credit" : invoice.type || "standard",
      subtotal: invoice.subtotal,
      total_vat: invoice.total_vat,
      total: invoice.total,
      amount_paid: invoice.amount_paid || 0,
      discount_type: invoice.discount_type,
      discount_value: invoice.discount_value,
      company: {
        name: invoice.company?.name || "",
        legal_name: invoice.company?.legal_name,
        siren: invoice.company?.siren || "",
        vat_number: invoice.company?.vat_number,
        address: invoice.company?.address || "",
        postal_code: invoice.company?.postal_code || "",
        city: invoice.company?.city || "",
        country: invoice.company?.country || "FR",
        phone: invoice.company?.phone,
        email: invoice.company?.email,
        logo_url: invoice.company?.logo_url,
        rib_iban: invoice.company?.rib_iban,
        rib_bic: invoice.company?.rib_bic,
        rib_bank_name: invoice.company?.rib_bank_name,
        is_vat_exempt: Boolean(invoice.company?.is_vat_exempt),
        vat_exemption_note: invoice.company?.vat_exemption_note,
      },
      client: {
        company_name: invoice.client?.company_name,
        first_name: invoice.client?.first_name,
        last_name: invoice.client?.last_name,
        siren: invoice.client?.siren,
        siret: invoice.client?.siret,
        vat_number: invoice.client?.vat_number,
        address: invoice.client?.address || "",
        postal_code: invoice.client?.postal_code || "",
        city: invoice.client?.city || "",
        country: invoice.client?.country || "FR",
        email: invoice.client?.email,
      },
      items: (invoice.items || []).map((item: any) => ({
        reference: item.reference,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        vat_rate: item.vat_rate,
        discount_type: item.discount_type,
        discount_value: item.discount_value,
        line_total: item.line_total,
      })),
      notes: invoice.notes,
      title: invoice.title,
      conditions: invoice.terms_and_conditions,
      facturx_profile: invoice.facturx_profile,
    };
  }

  private shouldPersistInvoicePdf(invoice: any): boolean {
    return invoice.status !== "draft";
  }

  private sanitizeFileSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, "_");
  }

  private buildInvoicePdfStoragePath(
    companyId: string,
    invoiceId: string,
    invoiceNumber: string,
  ): string {
    const safeInvoiceNumber = this.sanitizeFileSegment(invoiceNumber);
    return `${companyId}/invoices/${invoiceId}/facture-${safeInvoiceNumber}.pdf`;
  }

  private async getStoredInvoicePdfDocument(
    companyId: string,
    invoiceId: string,
  ): Promise<StoredDocumentRecord | null> {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .eq("company_id", companyId)
      .eq("related_type", "invoice")
      .eq("related_id", invoiceId)
      .eq("type", "invoice_pdf")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        `Erreur lors de la récupération du PDF stocké: ${error.message}`,
      );
    }

    return (data as StoredDocumentRecord | null) || null;
  }

  private async readPrivateDocumentBuffer(
    storagePath: string,
  ): Promise<Buffer> {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage
      .from(this.documentsBucket)
      .download(storagePath);

    if (error || !data) {
      throw new Error(error?.message || "Document introuvable dans le storage");
    }

    return Buffer.from(await data.arrayBuffer());
  }

  private async persistInvoicePdfDocument(
    invoice: any,
    existingDocument: StoredDocumentRecord | null,
    pdfBuffer: Buffer,
    uploadedBy: string,
  ): Promise<{ documentId: string; storagePath: string }> {
    const supabase = getSupabaseAdmin();
    const storagePath = this.buildInvoicePdfStoragePath(
      invoice.company_id,
      invoice.id,
      invoice.invoice_number,
    );
    const fileName = path.basename(storagePath);

    const { error: uploadError } = await supabase.storage
      .from(this.documentsBucket)
      .upload(storagePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Erreur lors du stockage du PDF: ${uploadError.message}`,
      );
    }

    const metadata = {
      company_id: invoice.company_id,
      uploaded_by: uploadedBy,
      type: "invoice_pdf",
      related_type: "invoice",
      related_id: invoice.id,
      filename: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdfBuffer.length,
    };

    if (existingDocument) {
      const { data, error } = await supabase
        .from("documents")
        .update(metadata)
        .eq("id", existingDocument.id)
        .select("id")
        .single();

      if (error || !data) {
        throw new InternalServerErrorException(
          `Erreur lors de la mise à jour du document PDF: ${error?.message || "inconnue"}`,
        );
      }

      return { documentId: data.id, storagePath };
    }

    const { data, error } = await supabase
      .from("documents")
      .insert(metadata)
      .select("id")
      .single();

    if (error || !data) {
      throw new InternalServerErrorException(
        `Erreur lors de l'enregistrement du document PDF: ${error?.message || "inconnue"}`,
      );
    }

    return { documentId: data.id, storagePath };
  }

  async getOrCreateInvoicePdf(
    invoice: any,
    uploadedBy?: string,
  ): Promise<StoredInvoicePdfResult> {
    const shouldPersist = this.shouldPersistInvoicePdf(invoice);
    const uploaderId = uploadedBy || invoice.created_by;
    const existingDocument = shouldPersist
      ? await this.getStoredInvoicePdfDocument(invoice.company_id, invoice.id)
      : null;

    if (existingDocument) {
      try {
        const buffer = await this.readPrivateDocumentBuffer(
          existingDocument.storage_path,
        );
        return {
          buffer,
          documentId: existingDocument.id,
          storagePath: existingDocument.storage_path,
          fromStorage: true,
        };
      } catch (error: any) {
        this.logger.warn(
          `Stored invoice PDF fallback to regeneration for ${invoice.id}: ${error.message}`,
        );
      }
    }

    const pdfBuffer = await this.generateFacturXPdf(
      this.formatInvoiceForPdf(invoice),
    );

    if (!shouldPersist || !uploaderId) {
      return {
        buffer: pdfBuffer,
        documentId: null,
        storagePath: null,
        fromStorage: false,
      };
    }

    const persisted = await this.persistInvoicePdfDocument(
      invoice,
      existingDocument,
      pdfBuffer,
      uploaderId,
    );

    return {
      buffer: pdfBuffer,
      documentId: persisted.documentId,
      storagePath: persisted.storagePath,
      fromStorage: false,
    };
  }

  /**
   * Génère le HTML pour une facture
   */
  private generateInvoiceHtml(data: InvoiceData): string {
    const clientName =
      data.client.company_name ||
      `${data.client.first_name || ""} ${data.client.last_name || ""}`.trim();
    const companyLogoUrl = this.resolveCompanyLogoUrl(data.company.logo_url);
    const platformFooterBranding = !companyLogoUrl
      ? this.renderPlatformFooterBranding()
      : "";

    const typeLabels: Record<string, string> = {
      standard: "FACTURE",
      deposit: "FACTURE D'ACOMPTE",
      final: "FACTURE DE SOLDE",
      credit: "AVOIR",
    };

    const vatGroups = this.groupByVatRate(data.items);
    const isVatExempt = Boolean(data.company.is_vat_exempt);
    const totalLabel = isVatExempt ? "Total HT" : "Total TTC";
    const vatExemptionNote =
      data.company.vat_exemption_note || "TVA non applicable, art. 293 B du CGI";

    return `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${typeLabels[data.type]} ${data.invoice_number}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            font-size: 10pt;
            line-height: 1.4;
            color: #333;
            padding: 40px;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 40px;
        }
        
        .logo {
            width: 84px;
            height: 84px;
            object-fit: contain;
            object-position: center;
            display: block;
            margin-bottom: 12px;
        }
        
        .company-info {
            text-align: left;
        }
        
        .company-name {
            font-size: 16pt;
            font-weight: bold;
            color: #1a1a1a;
            margin-bottom: 8px;
        }
        
        .company-details {
            font-size: 9pt;
            color: #666;
        }
        
        .invoice-title {
            text-align: right;
        }
        
        .invoice-type {
            font-size: 24pt;
            font-weight: bold;
            color: #2563eb;
            margin-bottom: 8px;
        }
        
        .invoice-number {
            font-size: 12pt;
            color: #666;
        }
        
        .addresses {
            display: flex;
            justify-content: space-between;
            margin-bottom: 30px;
            gap: 40px;
        }
        
        .address-block {
            flex: 1;
            padding: 20px;
            background: #f8fafc;
            border-radius: 8px;
        }
        
        .address-label {
            font-size: 8pt;
            text-transform: uppercase;
            color: #64748b;
            margin-bottom: 8px;
            font-weight: 600;
        }
        
        .address-name {
            font-size: 11pt;
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .dates {
            display: flex;
            gap: 40px;
            margin-bottom: 30px;
        }
        
        .date-item {
            padding: 12px 20px;
            background: #f1f5f9;
            border-radius: 6px;
        }
        
        .date-label {
            font-size: 8pt;
            text-transform: uppercase;
            color: #64748b;
        }
        
        .date-value {
            font-size: 11pt;
            font-weight: bold;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
        }
        
        thead {
            background: #1e293b;
            color: white;
        }
        
        th {
            padding: 12px 8px;
            text-align: left;
            font-size: 9pt;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        th:last-child {
            text-align: right;
        }
        
        td {
            padding: 12px 8px;
            border-bottom: 1px solid #e2e8f0;
            vertical-align: top;
        }
        
        td:last-child {
            text-align: right;
        }
        
        .item-ref {
            font-size: 8pt;
            color: #64748b;
        }
        
        .item-description {
            font-size: 10pt;
        }
        
        .text-right {
            text-align: right;
        }
        
        .text-center {
            text-align: center;
        }
        
        .totals {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 30px;
        }
        
        .totals-table {
            width: 300px;
        }
        
        .totals-table td {
            padding: 8px;
            border: none;
        }
        
        .totals-table .total-row {
            background: #1e293b;
            color: white;
            font-weight: bold;
            font-size: 12pt;
        }
        
        .totals-table .total-row td {
            padding: 12px;
        }
        
        .payment-info {
            margin-top: 30px;
            padding: 20px;
            background: #f8fafc;
            border-radius: 8px;
        }
        
        .payment-title {
            font-weight: bold;
            margin-bottom: 10px;
            font-size: 11pt;
        }
        
        .payment-details {
            display: flex;
            gap: 40px;
        }
        
        .payment-detail {
            font-size: 9pt;
        }
        
        .payment-label {
            color: #64748b;
        }
        
        .notes {
            margin-top: 20px;
            padding: 15px;
            background: #fffbeb;
            border-left: 4px solid #f59e0b;
            font-size: 9pt;
            white-space: pre-line;
            text-align: justify;
            text-justify: inter-word;
        }

        .conditions {
            margin-top: 30px;
            padding: 20px;
            background: #f8fafc;
            border-radius: 8px;
            white-space: pre-line;
            text-align: justify;
            text-justify: inter-word;
        }

        .conditions-title {
            font-weight: bold;
            margin-bottom: 10px;
            font-size: 11pt;
        }

        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
            text-align: center;
            font-size: 8pt;
            color: #64748b;
        }

        .footer-branding {
            margin-top: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            font-size: 7pt;
            color: #94a3b8;
        }

        .footer-branding-logo {
            height: 12px;
            width: auto;
            object-fit: contain;
        }
        
        .vat-details {
            margin-top: 10px;
            font-size: 9pt;
        }
        
        .vat-table {
            width: auto;
            margin-left: auto;
        }
        
        .vat-table td {
            padding: 4px 12px;
            border: none;
            font-size: 9pt;
        }
        
        .amount-due {
            margin-top: 20px;
            padding: 15px;
            background: ${data.amount_paid >= data.total ? "#dcfce7" : "#fef3c7"};
            border-radius: 8px;
            text-align: center;
        }
        
        .amount-due-label {
            font-size: 10pt;
            color: #666;
        }
        
        .amount-due-value {
            font-size: 18pt;
            font-weight: bold;
            color: ${data.amount_paid >= data.total ? "#16a34a" : "#d97706"};
        }
        
        @media print {
            body {
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="company-info">
            ${companyLogoUrl ? `<img src="${companyLogoUrl}" class="logo" alt="Logo ${data.company.name || "de l'entreprise"}">` : ""}
            <div class="company-name">${data.company.name}</div>
            <div class="company-details">
                ${data.company.address ? `${data.company.address}<br>` : ""}
                ${data.company.postal_code || data.company.city ? `${data.company.postal_code} ${data.company.city}<br>` : ""}
                ${data.company.phone ? `Tél: ${data.company.phone}<br>` : ""}
                ${data.company.email ? `Email: ${data.company.email}<br>` : ""}
                ${data.company.siren ? `SIREN: ${data.company.siren}` : ""}
                ${data.company.vat_number ? `<br>TVA: ${data.company.vat_number}` : ""}
            </div>
        </div>
        <div class="invoice-title">
            <div class="invoice-type">${typeLabels[data.type]}</div>
            <div class="invoice-number">N° ${data.invoice_number}</div>
        </div>
    </div>

    <div class="addresses">
        <div class="address-block">
            <div class="address-label">Adressé à</div>
            <div class="address-name">${clientName}</div>
            <div>
                ${data.client.address}<br>
                ${data.client.postal_code} ${data.client.city}
                ${data.client.siren ? `<br>SIREN: ${data.client.siren}` : ""}
                ${data.client.siret ? `<br>SIRET: ${data.client.siret}` : ""}
                ${data.client.vat_number ? `<br>TVA: ${data.client.vat_number}` : ""}
            </div>
        </div>
    </div>

    <div class="dates">
        <div class="date-item">
            <div class="date-label">Date d'émission</div>
            <div class="date-value">${this.formatDate(data.issue_date)}</div>
        </div>
        <div class="date-item">
            <div class="date-label">Date d'échéance</div>
            <div class="date-value">${this.formatDate(data.due_date)}</div>
        </div>
    </div>

    ${data.title ? `<h2 style="margin-bottom: 20px; font-size: 14pt;">${data.title}</h2>` : ""}

    <table>
        <thead>
            <tr>
                <th style="width: 50%">Désignation</th>
                <th class="text-center" style="width: 10%">Qté</th>
                <th class="text-right" style="width: 15%">Prix unit. HT</th>
                <th class="text-center" style="width: 10%">TVA</th>
                <th class="text-right" style="width: 15%">Total HT</th>
            </tr>
        </thead>
        <tbody>
            ${data.items
              .map(
                (item) => `
                <tr>
                    <td>
                        ${item.reference ? `<div class="item-ref">${item.reference}</div>` : ""}
                        <div class="item-description">${item.description}</div>
                    </td>
                    <td class="text-center">${item.quantity}${item.unit ? ` ${item.unit}` : ""}</td>
                    <td class="text-right">${this.formatCurrency(item.unit_price)}</td>
                    <td class="text-center">${item.vat_rate}%</td>
                    <td class="text-right">${this.formatCurrency(item.line_total)}</td>
                </tr>
            `,
              )
              .join("")}
        </tbody>
    </table>

    <div class="totals">
        <table class="totals-table">
            <tr>
                <td>Total HT</td>
                <td class="text-right">${this.formatCurrency(data.subtotal)}</td>
            </tr>
            ${isVatExempt ? "" : vatGroups
              .map(
                (vg) => `
                <tr>
                    <td>TVA ${vg.rate}%</td>
                    <td class="text-right">${this.formatCurrency(vg.amount)}</td>
                </tr>
            `,
              )
              .join("")}
            ${
              isVatExempt
                ? `<tr><td colspan="2">${vatExemptionNote}</td></tr>`
                : ""
            }
            ${
              data.discount_value && data.discount_value > 0
                ? `
                <tr>
                    <td>Remise${data.discount_type === "percentage" ? ` (${data.discount_value}%)` : ""}</td>
                    <td class="text-right">-${this.formatCurrency(data.discount_type === "percentage" ? ((data.subtotal + data.total_vat) * data.discount_value) / 100 : data.discount_value)}</td>
                </tr>
            `
                : ""
            }
            <tr class="total-row">
                <td>${totalLabel}</td>
                <td class="text-right">${this.formatCurrency(data.total)}</td>
            </tr>
            ${
              data.amount_paid > 0
                ? `
                <tr>
                    <td>Déjà payé</td>
                    <td class="text-right">${this.formatCurrency(data.amount_paid)}</td>
                </tr>
                <tr style="font-weight: bold;">
                    <td>Reste à payer</td>
                    <td class="text-right">${this.formatCurrency(data.total - data.amount_paid)}</td>
                </tr>
            `
                : ""
            }
        </table>
    </div>

    ${
      data.amount_paid < data.total
        ? `
        <div class="amount-due">
            <div class="amount-due-label">Montant à régler</div>
            <div class="amount-due-value">${this.formatCurrency(data.total - data.amount_paid)}</div>
        </div>
    `
        : `
        <div class="amount-due">
            <div class="amount-due-label">Statut</div>
            <div class="amount-due-value">PAYÉE</div>
        </div>
    `
    }

    ${
      data.company.rib_iban
        ? `
        <div class="payment-info">
            <div class="payment-title">Informations bancaires</div>
            <div class="payment-details">
                ${data.company.rib_bank_name ? `<div class="payment-detail"><span class="payment-label">Banque:</span> ${data.company.rib_bank_name}</div>` : ""}
                <div class="payment-detail"><span class="payment-label">IBAN:</span> ${data.company.rib_iban}</div>
                ${data.company.rib_bic ? `<div class="payment-detail"><span class="payment-label">BIC:</span> ${data.company.rib_bic}</div>` : ""}
            </div>
        </div>
    `
        : ""
    }

    ${
      data.notes
        ? `
        <div class="notes">
            <strong>Notes:</strong><br>
            ${data.notes}
        </div>
    `
        : ""
    }

    ${
      data.conditions
        ? `
        <div class="conditions">
            <div class="conditions-title">Conditions générales</div>
            <div>${data.conditions}</div>
        </div>
    `
        : ""
    }

    <div class="footer">
        ${data.company.legal_name || data.company.name}${data.company.siren ? ` - SIREN: ${data.company.siren}` : ""}${data.company.vat_number ? ` - TVA Intracommunautaire: ${data.company.vat_number}` : ""}
        ${data.facturx_profile ? `<br>Document conforme au format Factur-X (${data.facturx_profile.toUpperCase()})` : ""}
        ${platformFooterBranding}
    </div>
</body>
</html>
        `;
  }

  /**
   * Génère le HTML pour un devis
   */
  private generateQuoteHtml(data: QuoteData): string {
    const clientName =
      data.client.company_name ||
      `${data.client.first_name || ""} ${data.client.last_name || ""}`.trim();
    const companyLogoUrl = this.resolveCompanyLogoUrl(data.company.logo_url);
    const platformFooterBranding = !companyLogoUrl
      ? this.renderPlatformFooterBranding()
      : "";

    const vatGroups = this.groupByVatRate(data.items);
    const isVatExempt = Boolean(data.company.is_vat_exempt);
    const totalLabel = isVatExempt ? "Total HT" : "Total TTC";
    const vatExemptionNote =
      data.company.vat_exemption_note || "TVA non applicable, art. 293 B du CGI";

    return `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DEVIS ${data.quote_number}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            font-size: 10pt;
            line-height: 1.4;
            color: #333;
            padding: 40px;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 40px;
        }
        
        .logo {
            width: 84px;
            height: 84px;
            object-fit: contain;
            object-position: center;
            display: block;
            margin-bottom: 12px;
        }
        
        .company-info {
            text-align: left;
        }
        
        .company-name {
            font-size: 16pt;
            font-weight: bold;
            color: #1a1a1a;
            margin-bottom: 8px;
        }
        
        .company-details {
            font-size: 9pt;
            color: #666;
        }
        
        .quote-title {
            text-align: right;
        }
        
        .quote-type {
            font-size: 24pt;
            font-weight: bold;
            color: #7c3aed;
            margin-bottom: 8px;
        }
        
        .quote-number {
            font-size: 12pt;
            color: #666;
        }
        
        .addresses {
            display: flex;
            justify-content: space-between;
            margin-bottom: 30px;
            gap: 40px;
        }
        
        .address-block {
            flex: 1;
            padding: 20px;
            background: #f8fafc;
            border-radius: 8px;
        }
        
        .address-label {
            font-size: 8pt;
            text-transform: uppercase;
            color: #64748b;
            margin-bottom: 8px;
            font-weight: 600;
        }
        
        .address-name {
            font-size: 11pt;
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .dates {
            display: flex;
            gap: 40px;
            margin-bottom: 30px;
        }
        
        .date-item {
            padding: 12px 20px;
            background: #f1f5f9;
            border-radius: 6px;
        }
        
        .date-label {
            font-size: 8pt;
            text-transform: uppercase;
            color: #64748b;
        }
        
        .date-value {
            font-size: 11pt;
            font-weight: bold;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
        }
        
        thead {
            background: #5b21b6;
            color: white;
        }
        
        th {
            padding: 12px 8px;
            text-align: left;
            font-size: 9pt;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        th:last-child {
            text-align: right;
        }
        
        td {
            padding: 12px 8px;
            border-bottom: 1px solid #e2e8f0;
            vertical-align: top;
        }
        
        td:last-child {
            text-align: right;
        }
        
        .item-ref {
            font-size: 8pt;
            color: #64748b;
        }
        
        .item-description {
            font-size: 10pt;
        }
        
        .text-right {
            text-align: right;
        }
        
        .text-center {
            text-align: center;
        }
        
        .totals {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 30px;
        }
        
        .totals-table {
            width: 300px;
        }
        
        .totals-table td {
            padding: 8px;
            border: none;
        }
        
        .totals-table .total-row {
            background: #5b21b6;
            color: white;
            font-weight: bold;
            font-size: 12pt;
        }
        
        .totals-table .total-row td {
            padding: 12px;
        }
        
        .conditions {
            margin-top: 30px;
            padding: 20px;
            background: #f8fafc;
            border-radius: 8px;
            white-space: pre-line;
            text-align: justify;
            text-justify: inter-word;
        }
        
        .conditions-title {
            font-weight: bold;
            margin-bottom: 10px;
            font-size: 11pt;
        }
        
        .notes {
            margin-top: 20px;
            padding: 15px;
            background: #fffbeb;
            border-left: 4px solid #f59e0b;
            white-space: pre-line;
            text-align: justify;
            text-justify: inter-word;
            font-size: 9pt;
        }
        
        .signature-area {
            margin-top: 40px;
            display: flex;
            justify-content: flex-end;
        }
        
        .signature-box {
            width: 250px;
            padding: 20px;
            border: 2px dashed #d1d5db;
            border-radius: 8px;
        }
        
        .signature-label {
            font-size: 9pt;
            color: #64748b;
            margin-bottom: 60px;
        }
        
        .signature-line {
            border-top: 1px solid #333;
            padding-top: 5px;
            font-size: 8pt;
            color: #64748b;
        }
        
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
            text-align: center;
            font-size: 8pt;
            color: #64748b;
        }

        .footer-branding {
            margin-top: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            font-size: 7pt;
            color: #94a3b8;
        }

        .footer-branding-logo {
            height: 12px;
            width: auto;
            object-fit: contain;
        }
        
        .validity-notice {
            margin-top: 20px;
            padding: 15px;
            background: #ede9fe;
            border-radius: 8px;
            text-align: center;
            font-size: 10pt;
            color: #5b21b6;
        }
        
        @media print {
            body {
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="company-info">
            ${companyLogoUrl ? `<img src="${companyLogoUrl}" class="logo" alt="Logo ${data.company.name || "de l'entreprise"}">` : ""}
            <div class="company-name">${data.company.name}</div>
            <div class="company-details">
                ${data.company.address ? `${data.company.address}<br>` : ""}
                ${data.company.postal_code || data.company.city ? `${data.company.postal_code} ${data.company.city}<br>` : ""}
                ${data.company.phone ? `Tél: ${data.company.phone}<br>` : ""}
                ${data.company.email ? `Email: ${data.company.email}<br>` : ""}
                ${data.company.siren ? `SIREN: ${data.company.siren}` : ""}
                ${data.company.vat_number ? `<br>TVA: ${data.company.vat_number}` : ""}
            </div>
        </div>
        <div class="quote-title">
            <div class="quote-type">DEVIS</div>
            <div class="quote-number">N° ${data.quote_number}</div>
        </div>
    </div>

    <div class="addresses">
        <div class="address-block">
            <div class="address-label">Adressé à</div>
            <div class="address-name">${clientName}</div>
            <div>
                ${data.client.address}<br>
                ${data.client.postal_code} ${data.client.city}
                ${data.client.siren ? `<br>SIREN: ${data.client.siren}` : ""}
                ${data.client.siret ? `<br>SIRET: ${data.client.siret}` : ""}
            </div>
        </div>
    </div>

    <div class="dates">
        <div class="date-item">
            <div class="date-label">Date d'émission</div>
            <div class="date-value">${this.formatDate(data.issue_date)}</div>
        </div>
        <div class="date-item">
            <div class="date-label">Valide jusqu'au</div>
            <div class="date-value">${this.formatDate(data.validity_date)}</div>
        </div>
    </div>

    ${data.title ? `<h2 style="margin-bottom: 20px; font-size: 14pt;">${data.title}</h2>` : ""}

    <table>
        <thead>
            <tr>
                <th style="width: 50%">Désignation</th>
                <th class="text-center" style="width: 10%">Qté</th>
                <th class="text-right" style="width: 15%">Prix unit. HT</th>
                <th class="text-center" style="width: 10%">TVA</th>
                <th class="text-right" style="width: 15%">Total HT</th>
            </tr>
        </thead>
        <tbody>
            ${data.items
              .map(
                (item) => `
                <tr>
                    <td>
                        ${item.reference ? `<div class="item-ref">${item.reference}</div>` : ""}
                        <div class="item-description">${item.description}</div>
                    </td>
                    <td class="text-center">${item.quantity}${item.unit ? ` ${item.unit}` : ""}</td>
                    <td class="text-right">${this.formatCurrency(item.unit_price)}</td>
                    <td class="text-center">${item.vat_rate}%</td>
                    <td class="text-right">${this.formatCurrency(item.line_total)}</td>
                </tr>
            `,
              )
              .join("")}
        </tbody>
    </table>

    <div class="totals">
        <table class="totals-table">
            <tr>
                <td>Total HT</td>
                <td class="text-right">${this.formatCurrency(data.subtotal)}</td>
            </tr>
            ${isVatExempt ? "" : vatGroups
              .map(
                (vg) => `
                <tr>
                    <td>TVA ${vg.rate}%</td>
                    <td class="text-right">${this.formatCurrency(vg.amount)}</td>
                </tr>
            `,
              )
              .join("")}
            ${
              isVatExempt
                ? `<tr><td colspan="2">${vatExemptionNote}</td></tr>`
                : ""
            }
            ${
              data.discount_value && data.discount_value > 0
                ? `
                <tr>
                    <td>Remise${data.discount_type === "percentage" ? ` (${data.discount_value}%)` : ""}</td>
                    <td class="text-right">-${this.formatCurrency(data.discount_type === "percentage" ? ((data.subtotal + data.total_vat) * data.discount_value) / 100 : data.discount_value)}</td>
                </tr>
            `
                : ""
            }
            <tr class="total-row">
                <td>${totalLabel}</td>
                <td class="text-right">${this.formatCurrency(data.total)}</td>
            </tr>
        </table>
    </div>

    <div class="validity-notice">
        Ce devis est valable jusqu'au <strong>${this.formatDate(data.validity_date)}</strong>
    </div>

    ${
      data.conditions
        ? `
        <div class="conditions">
            <div class="conditions-title">Conditions générales</div>
            <div>${data.conditions}</div>
        </div>
    `
        : ""
    }

    ${
      data.notes
        ? `
        <div class="notes">
            <strong>Notes:</strong><br>
            ${data.notes}
        </div>
    `
        : ""
    }

    <div class="signature-area">
        <div class="signature-box">
            <div class="signature-label">
                Bon pour accord<br>
                Date et signature du client :
            </div>
            <div style="color: #ffffff; font-size: 1px; line-height: 1; user-select: none;">
                {{s1|signature|170|74}}
            </div>
            <div class="signature-line">Signature précédée de la mention "Bon pour accord"</div>
        </div>
    </div>

    <div class="footer">
        ${data.company.legal_name || data.company.name}${data.company.siren ? ` - SIREN: ${data.company.siren}` : ""}${data.company.vat_number ? ` - TVA Intracommunautaire: ${data.company.vat_number}` : ""}
        ${platformFooterBranding}
    </div>
</body>
</html>
        `;
  }

  /**
   * Groupe les lignes par taux de TVA
   */
  private groupByVatRate(
    items: InvoiceData["items"],
  ): Array<{ rate: number; base: number; amount: number }> {
    const groups: Record<number, { base: number; amount: number }> = {};

    items.forEach((item) => {
      if (!groups[item.vat_rate]) {
        groups[item.vat_rate] = { base: 0, amount: 0 };
      }
      groups[item.vat_rate].base += item.line_total;
      groups[item.vat_rate].amount += item.line_total * (item.vat_rate / 100);
    });

    return Object.entries(groups)
      .map(([rate, data]) => ({
        rate: Number(rate),
        base: Math.round(data.base * 100) / 100,
        amount: Math.round(data.amount * 100) / 100,
      }))
      .sort((a, b) => a.rate - b.rate);
  }

  /**
   * Génère le XML Factur-X
   */
  private generateFacturXXml(data: InvoiceData): string {
    const profile = data.facturx_profile || FacturXProfile.MINIMUM;
    const clientName =
      data.client.company_name ||
      `${data.client.first_name || ""} ${data.client.last_name || ""}`.trim();

    // Format de date pour XML: YYYYMMDD
    const formatXmlDate = (dateStr: string) => dateStr.replace(/-/g, "");

    // Type de document
    const typeCode = {
      standard: "380",
      deposit: "386",
      final: "380",
      credit: "381",
    }[data.type];

    return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
    xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
    xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
    
    <rsm:ExchangedDocumentContext>
        <ram:GuidelineSpecifiedDocumentContextParameter>
            <ram:ID>urn:factur-x.eu:1p0:${profile}</ram:ID>
        </ram:GuidelineSpecifiedDocumentContextParameter>
    </rsm:ExchangedDocumentContext>
    
    <rsm:ExchangedDocument>
        <ram:ID>${data.invoice_number}</ram:ID>
        <ram:TypeCode>${typeCode}</ram:TypeCode>
        <ram:IssueDateTime>
            <udt:DateTimeString format="102">${formatXmlDate(data.issue_date)}</udt:DateTimeString>
        </ram:IssueDateTime>
    </rsm:ExchangedDocument>
    
    <rsm:SupplyChainTradeTransaction>
        <ram:ApplicableHeaderTradeAgreement>
            <ram:SellerTradeParty>
                <ram:Name>${data.company.name}</ram:Name>
                ${data.company.legal_name ? `<ram:Description>${data.company.legal_name}</ram:Description>` : ""}
                <ram:PostalTradeAddress>
                    <ram:LineOne>${data.company.address}</ram:LineOne>
                    <ram:PostcodeCode>${data.company.postal_code}</ram:PostcodeCode>
                    <ram:CityName>${data.company.city}</ram:CityName>
                    <ram:CountryID>${data.company.country || "FR"}</ram:CountryID>
                </ram:PostalTradeAddress>
                ${
                  data.company.vat_number
                    ? `
                <ram:SpecifiedTaxRegistration>
                    <ram:ID schemeID="VA">${data.company.vat_number}</ram:ID>
                </ram:SpecifiedTaxRegistration>
                `
                    : ""
                }
                <ram:SpecifiedTaxRegistration>
                    <ram:ID schemeID="0002">${data.company.siren}</ram:ID>
                </ram:SpecifiedTaxRegistration>
            </ram:SellerTradeParty>
            
            <ram:BuyerTradeParty>
                <ram:Name>${clientName}</ram:Name>
                <ram:PostalTradeAddress>
                    <ram:LineOne>${data.client.address}</ram:LineOne>
                    <ram:PostcodeCode>${data.client.postal_code}</ram:PostcodeCode>
                    <ram:CityName>${data.client.city}</ram:CityName>
                    <ram:CountryID>${data.client.country || "FR"}</ram:CountryID>
                </ram:PostalTradeAddress>
                ${
                  data.client.vat_number
                    ? `
                <ram:SpecifiedTaxRegistration>
                    <ram:ID schemeID="VA">${data.client.vat_number}</ram:ID>
                </ram:SpecifiedTaxRegistration>
                `
                    : ""
                }
                ${
                  data.client.siret
                    ? `
                <ram:SpecifiedTaxRegistration>
                    <ram:ID schemeID="0002">${data.client.siret}</ram:ID>
                </ram:SpecifiedTaxRegistration>
                `
                    : ""
                }
            </ram:BuyerTradeParty>
        </ram:ApplicableHeaderTradeAgreement>
        
        <ram:ApplicableHeaderTradeDelivery/>
        
        <ram:ApplicableHeaderTradeSettlement>
            <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
            
            ${
              data.company.rib_iban
                ? `
            <ram:SpecifiedTradeSettlementPaymentMeans>
                <ram:TypeCode>58</ram:TypeCode>
                <ram:PayeePartyCreditorFinancialAccount>
                    <ram:IBANID>${data.company.rib_iban}</ram:IBANID>
                </ram:PayeePartyCreditorFinancialAccount>
                ${
                  data.company.rib_bic
                    ? `
                <ram:PayeeSpecifiedCreditorFinancialInstitution>
                    <ram:BICID>${data.company.rib_bic}</ram:BICID>
                </ram:PayeeSpecifiedCreditorFinancialInstitution>
                `
                    : ""
                }
            </ram:SpecifiedTradeSettlementPaymentMeans>
            `
                : ""
            }
            
            ${this.groupByVatRate(data.items)
              .map(
                (vg) => `
            <ram:ApplicableTradeTax>
                <ram:CalculatedAmount>${vg.amount.toFixed(2)}</ram:CalculatedAmount>
                <ram:TypeCode>VAT</ram:TypeCode>
                <ram:BasisAmount>${vg.base.toFixed(2)}</ram:BasisAmount>
                <ram:CategoryCode>S</ram:CategoryCode>
                <ram:RateApplicablePercent>${vg.rate}</ram:RateApplicablePercent>
            </ram:ApplicableTradeTax>
            `,
              )
              .join("")}
            
            <ram:SpecifiedTradePaymentTerms>
                <ram:DueDateDateTime>
                    <udt:DateTimeString format="102">${formatXmlDate(data.due_date)}</udt:DateTimeString>
                </ram:DueDateDateTime>
            </ram:SpecifiedTradePaymentTerms>
            
            <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
                <ram:LineTotalAmount>${data.subtotal.toFixed(2)}</ram:LineTotalAmount>
                <ram:TaxBasisTotalAmount>${data.subtotal.toFixed(2)}</ram:TaxBasisTotalAmount>
                <ram:TaxTotalAmount currencyID="EUR">${data.total_vat.toFixed(2)}</ram:TaxTotalAmount>
                <ram:GrandTotalAmount>${data.total.toFixed(2)}</ram:GrandTotalAmount>
                <ram:DuePayableAmount>${(data.total - data.amount_paid).toFixed(2)}</ram:DuePayableAmount>
            </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        </ram:ApplicableHeaderTradeSettlement>
    </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
  }

  /**
   * Génère un PDF à partir de HTML avec retry en cas d'erreur de connexion
   */
  private async generatePdfFromHtml(
    html: string,
    retries = 1,
  ): Promise<Buffer> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const browser = await this.getBrowser();
        const page = await browser.newPage();

        await page.setContent(html, { waitUntil: "networkidle0" });

        const pdfBuffer = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: {
            top: "10mm",
            right: "10mm",
            bottom: "10mm",
            left: "10mm",
          },
        });

        await page.close();

        return Buffer.from(pdfBuffer);
      } catch (error: any) {
        lastError = error;
        console.error(
          `Error generating PDF (attempt ${attempt + 1}/${retries + 1}):`,
          error.message,
        );

        // Si erreur de connexion, forcer la recréation du navigateur au prochain essai
        if (
          error.name === "ConnectionClosedError" ||
          error.message?.includes("Connection closed")
        ) {
          this.browser = null;
        }

        if (attempt < retries) {
          // Attendre un peu avant de réessayer
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }

    throw new InternalServerErrorException(
      "Erreur lors de la génération du PDF: " +
        (lastError?.message || "Unknown error"),
    );
  }

  /**
   * Génère un PDF de facture
   */
  async generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
    try {
      const html = this.generateInvoiceHtml(data);
      return await this.generatePdfFromHtml(html);
    } catch (error) {
      console.error("Error generating invoice PDF:", error);
      throw error;
    }
  }

  /**
   * Génère un PDF de devis
   */
  async generateQuotePdf(data: QuoteData): Promise<Buffer> {
    try {
      const html = this.generateQuoteHtml(data);
      return await this.generatePdfFromHtml(html);
    } catch (error) {
      console.error("Error generating quote PDF:", error);
      throw error;
    }
  }

  /**
   * Embarque le XML Factur-X dans le PDF de facture.
   * Le XML est joint comme fichier associé pour faciliter l'échange B2G/B2B.
   */
  private async embedFacturXXmlInPdf(
    pdfBuffer: Buffer,
    xml: string,
    invoiceNumber: string,
  ): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: true });
    const now = new Date();

    pdfDoc.setProducer("Projet Berkant");
    pdfDoc.setCreator("Projet Berkant");
    pdfDoc.setTitle(`Facture ${invoiceNumber} (Factur-X)`);
    pdfDoc.setCreationDate(now);
    pdfDoc.setModificationDate(now);

    await pdfDoc.attach(Buffer.from(xml, "utf-8"), "factur-x.xml", {
      mimeType: "application/xml",
      description: "Factur-X invoice XML (CII)",
      creationDate: now,
      modificationDate: now,
      afRelationship: "Alternative" as any,
    });

    const bytes = await pdfDoc.save({ useObjectStreams: false });
    return Buffer.from(bytes);
  }

  /**
   * Génère un PDF Factur-X (avec XML intégré)
   */
  async generateFacturXPdf(data: InvoiceData): Promise<Buffer> {
    try {
      const pdfBuffer = await this.generateInvoicePdf(data);
      const xml = this.generateFacturXXml(data);
      return this.embedFacturXXmlInPdf(pdfBuffer, xml, data.invoice_number);
    } catch (error) {
      console.error("Error generating Factur-X PDF:", error);
      throw new InternalServerErrorException(
        "Erreur lors de la génération du PDF Factur-X",
      );
    }
  }

  /**
   * Stocke un PDF dans Supabase Storage
   */
  async storePdf(
    companyId: string,
    documentType: "invoice" | "quote",
    documentNumber: string,
    pdfBuffer: Buffer,
  ): Promise<string> {
    const supabase = getSupabaseAdmin();

    const fileName = `${companyId}/${documentType}s/${documentNumber}.pdf`;

    const { data, error } = await supabase.storage
      .from(this.documentsBucket)
      .upload(fileName, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (error) {
      console.error("Error storing PDF:", error);
      throw new InternalServerErrorException("Erreur lors du stockage du PDF");
    }

    const { data: urlData, error: signedUrlError } = await supabase.storage
      .from(this.documentsBucket)
      .createSignedUrl(fileName, 3600);

    if (signedUrlError) {
      throw new InternalServerErrorException(
        "Erreur lors de la génération de l'URL du PDF",
      );
    }

    return urlData.signedUrl;
  }
}
