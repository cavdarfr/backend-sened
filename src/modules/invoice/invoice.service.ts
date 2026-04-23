import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { getSupabaseAdmin } from "../../config/supabase.config";
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  InvoiceQueryDto,
  SignInvoiceDto,
  RecordPaymentDto,
  CreateDepositInvoiceDto,
  CancelInvoiceDto,
  Invoice,
  InvoiceItem,
  InvoiceListResponse,
  InvoiceStatus,
  InvoiceType,
  InvoiceItemDto,
  InvoiceStats,
  Payment,
} from "./dto/invoice.dto";
import { computeInvoiceStats } from "./invoice-stats.util";
import { NotificationService } from "../reminder/notification.service";
import { PdfService } from "../pdf/pdf.service";
import { WebsocketGateway } from "../websocket/websocket.gateway";
import { ChorusProService } from "../chorus-pro/chorus-pro.service";
import { CreateCreditNoteDto } from "./dto/invoice.dto";
import {
  getUserCompanyRole,
  getUserCompanyAccessContext,
  canCreateCompanyCreditNote,
  canDeleteCompanyDocuments,
  canViewCompanyDraftDocuments,
  canWriteCompanyDocuments,
  CompanyRole,
} from "../../common/roles/roles";

type CancelInvoiceRpcResult = {
  invoice_id: string;
  credit_note_id: string | null;
};

type LinkedCreditNoteRow = {
  id: string;
  invoice_number: string;
  parent_invoice_id: string | null;
};

@Injectable()
export class InvoiceService {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly pdfService: PdfService,
    private readonly websocketGateway: WebsocketGateway,
    private readonly chorusProService: ChorusProService,
  ) {}

  private async checkCompanyAccess(
    userId: string,
    companyId: string,
  ): Promise<CompanyRole> {
    return getUserCompanyRole(userId, companyId);
  }

  private async checkWriteAccess(
    userId: string,
    companyId: string,
  ): Promise<CompanyRole> {
    const accessContext = await getUserCompanyAccessContext(userId, companyId);

    if (!canWriteCompanyDocuments(accessContext.role, accessContext.companyOwnerRole)) {
      throw new ForbiddenException(
        "Vous n'avez pas les permissions nécessaires pour cette action",
      );
    }

    return accessContext.role;
  }

  private async checkDeleteAccess(
    userId: string,
    companyId: string,
  ): Promise<CompanyRole> {
    const accessContext = await getUserCompanyAccessContext(userId, companyId);

    if (!canDeleteCompanyDocuments(accessContext.role, accessContext.companyOwnerRole)) {
      throw new ForbiddenException(
        "Vous n'avez pas les permissions nécessaires pour cette action",
      );
    }

    return accessContext.role;
  }

  private async checkCreditNoteAccess(
    userId: string,
    companyId: string,
  ): Promise<CompanyRole> {
    const accessContext = await getUserCompanyAccessContext(userId, companyId);

    if (!canCreateCompanyCreditNote(accessContext.role, accessContext.companyOwnerRole)) {
      throw new ForbiddenException(
        "Vous n'avez pas les permissions nécessaires pour cette action",
      );
    }

    return accessContext.role;
  }

  /**
   * Calcule les totaux d'une facture à partir des lignes
   */
  private calculateTotals(
    items: InvoiceItemDto[],
    globalDiscountType?: string,
    globalDiscountValue?: number,
  ): {
    subtotal: number;
    total_vat: number;
    total: number;
    itemsWithTotals: (InvoiceItemDto & { line_total: number })[];
  } {
    let subtotal = 0;
    let totalVat = 0;

    const itemsWithTotals = items.map((item) => {
      let lineSubtotal = item.quantity * item.unit_price;

      // Appliquer la remise de ligne
      if (item.discount_type && item.discount_value) {
        if (item.discount_type === "percentage") {
          lineSubtotal = lineSubtotal * (1 - item.discount_value / 100);
        } else {
          lineSubtotal = lineSubtotal - item.discount_value;
        }
      }

      const lineVat = lineSubtotal * (item.vat_rate / 100);
      subtotal += lineSubtotal;
      totalVat += lineVat;

      return {
        ...item,
        line_total: Math.round(lineSubtotal * 100) / 100,
      };
    });

    // Appliquer la remise globale
    let total = subtotal + totalVat;
    if (globalDiscountType && globalDiscountValue) {
      if (globalDiscountType === "percentage") {
        total = total * (1 - globalDiscountValue / 100);
      } else {
        total = total - globalDiscountValue;
      }
    }

    return {
      subtotal: Math.round(subtotal * 100) / 100,
      total_vat: Math.round(totalVat * 100) / 100,
      total: Math.round(total * 100) / 100,
      itemsWithTotals,
    };
  }

  private async normalizeItemsForCompanyVat(
    companyId: string,
    items: InvoiceItemDto[],
  ): Promise<InvoiceItemDto[]> {
    const supabase = getSupabaseAdmin();
    const { data: company } = await supabase
      .from("companies")
      .select("is_vat_exempt")
      .eq("id", companyId)
      .maybeSingle();

    if (!company?.is_vat_exempt) {
      return items;
    }

    return items.map((item) => ({
      ...item,
      vat_rate: 0,
    }));
  }

  /**
   * Génère le numéro de facture
   */
  private async generateInvoiceNumber(
    companyId: string,
    isCreditNote: boolean = false,
  ): Promise<string> {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase.rpc("generate_document_number", {
      p_company_id: companyId,
      p_type: isCreditNote ? "credit_note" : "invoice",
    });

    if (error) {
      console.error("Error generating invoice number:", error);
      throw new BadRequestException(
        "Erreur lors de la génération du numéro de facture",
      );
    }

    return data;
  }

  private throwInvoiceFlowError(error: any, fallbackMessage: string): never {
    console.error(fallbackMessage, error);

    const message =
      error?.message ||
      error?.details ||
      error?.hint ||
      fallbackMessage;

    if (message === "Facture non trouvée") {
      throw new NotFoundException(message);
    }

    if (
      [
        "Cette facture ne peut pas être annulée",
        "Une facture payée ne peut pas être annulée. Veuillez créer un avoir.",
      ].includes(message)
    ) {
      throw new ConflictException(message);
    }

    if (
      [
        "Impossible de créer un avoir sur un avoir",
        "Un avoir ne peut être créé que sur une facture non-brouillon et non-annulée",
        "Un avoir existe déjà pour cette facture",
        "Le montant de l'avoir ne peut pas dépasser le montant total de la facture",
        "Le montant de l'avoir doit être supérieur à 0",
      ].includes(message)
    ) {
      throw new BadRequestException(message);
    }

    throw new BadRequestException(message || fallbackMessage);
  }

  private async attachLinkedCreditNoteMetadata(
    companyId: string,
    invoices: Invoice[],
  ): Promise<Invoice[]> {
    const supabase = getSupabaseAdmin();
    const sourceInvoiceIds = invoices
      .filter((invoice) => invoice.type !== InvoiceType.CREDIT_NOTE)
      .map((invoice) => invoice.id);

    if (sourceInvoiceIds.length === 0) {
      return invoices.map((invoice) => ({
        ...invoice,
        has_credit_note: false,
        linked_credit_note_id: null,
        linked_credit_note_number: null,
      }));
    }

    const { data, error } = await supabase
      .from("invoices")
      .select("id, invoice_number, parent_invoice_id")
      .eq("company_id", companyId)
      .eq("type", InvoiceType.CREDIT_NOTE)
      .in("parent_invoice_id", sourceInvoiceIds)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching linked credit notes:", error);
      throw new BadRequestException(
        "Erreur lors de la récupération des avoirs liés",
      );
    }

    const creditNotesByParentId = new Map<string, LinkedCreditNoteRow>();
    for (const row of ((data || []) as LinkedCreditNoteRow[])) {
      if (row.parent_invoice_id && !creditNotesByParentId.has(row.parent_invoice_id)) {
        creditNotesByParentId.set(row.parent_invoice_id, row);
      }
    }

    return invoices.map((invoice) => {
      if (invoice.type === InvoiceType.CREDIT_NOTE) {
        return {
          ...invoice,
          has_credit_note: false,
          linked_credit_note_id: null,
          linked_credit_note_number: null,
        };
      }

      const linkedCreditNote = creditNotesByParentId.get(invoice.id);

      return {
        ...invoice,
        has_credit_note: Boolean(linkedCreditNote),
        linked_credit_note_id: linkedCreditNote?.id || null,
        linked_credit_note_number: linkedCreditNote?.invoice_number || null,
      };
    });
  }

  private async sendCreditNoteEmail(
    userId: string,
    companyId: string,
    creditNoteId: string,
  ): Promise<Invoice> {
    const fullCreditNote = await this.findOne(userId, companyId, creditNoteId);

    if (
      this.notificationService.isEmailConfigured() &&
      fullCreditNote.client &&
      fullCreditNote.company &&
      fullCreditNote.client.email
    ) {
      try {
        const pdfBuffer = (
          await this.pdfService.getOrCreateInvoicePdf(fullCreditNote, userId)
        ).buffer;

        await this.notificationService.sendInvoiceEmailV2(
          fullCreditNote,
          fullCreditNote.client,
          fullCreditNote.company,
          pdfBuffer,
        );
      } catch (emailError) {
        console.error("Error sending credit note email:", emailError);
      }
    }

    return fullCreditNote;
  }

  /**
   * Crée une nouvelle facture
   */
  async create(
    userId: string,
    companyId: string,
    dto: CreateInvoiceDto,
  ): Promise<Invoice> {
    await this.checkWriteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Vérifier que le client existe et appartient à l'entreprise
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id")
      .eq("id", dto.client_id)
      .eq("company_id", companyId)
      .single();

    if (clientError || !client) {
      throw new BadRequestException("Client non trouvé");
    }

    // Récupérer les paramètres de l'entreprise
    const { data: settings } = await supabase
      .from("document_settings")
      .select("default_payment_delay_days, facturx_profile")
      .eq("company_id", companyId)
      .single();

    const paymentDelayDays = settings?.default_payment_delay_days || 30;

    // Calculer les totaux
    const normalizedItems = await this.normalizeItemsForCompanyVat(
      companyId,
      dto.items,
    );
    const { subtotal, total_vat, total, itemsWithTotals } =
      this.calculateTotals(normalizedItems, dto.discount_type, dto.discount_value);

    // Générer le numéro de facture
    const invoiceNumber = await this.generateInvoiceNumber(companyId);

    // Calculer les dates
    const issueDate = dto.issue_date || new Date().toISOString().split("T")[0];
    const dueDate =
      dto.due_date ||
      new Date(
        new Date(issueDate).getTime() + paymentDelayDays * 24 * 60 * 60 * 1000,
      )
        .toISOString()
        .split("T")[0];

    // Créer la facture
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert({
        company_id: companyId,
        client_id: dto.client_id,
        quote_id: dto.quote_id || null,
        created_by: userId,
        invoice_number: invoiceNumber,
        status: InvoiceStatus.DRAFT,
        type: dto.type || InvoiceType.STANDARD,
        parent_invoice_id: dto.parent_invoice_id || null,
        title: dto.title || null,
        subject: dto.subject || null,
        issue_date: issueDate,
        due_date: dueDate,
        subtotal,
        total_vat,
        total,
        discount_type: dto.discount_type || null,
        discount_value: dto.discount_value || 0,
        amount_paid: 0,
        notes: dto.notes || null,
        footer: dto.footer || null,
        terms_and_conditions: dto.terms_and_conditions || null,
        facturx_profile:
          dto.facturx_profile || settings?.facturx_profile || "minimum",
      })
      .select()
      .single();

    if (invoiceError) {
      console.error("Error creating invoice:", invoiceError);
      throw new BadRequestException("Erreur lors de la création de la facture");
    }

    // Créer les lignes de facture
    if (itemsWithTotals.length > 0) {
      const invoiceItems = itemsWithTotals.map((item, index) => ({
        invoice_id: invoice.id,
        product_id: item.product_id || null,
        position: item.position ?? index,
        reference: item.reference || null,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit || null,
        unit_price: item.unit_price,
        vat_rate: item.vat_rate,
        discount_type: item.discount_type || null,
        discount_value: item.discount_value || 0,
        line_total: item.line_total,
      }));

      const { error: itemsError } = await supabase
        .from("invoice_items")
        .insert(invoiceItems);

      if (itemsError) {
        console.error("Error creating invoice items:", itemsError);
        await supabase.from("invoices").delete().eq("id", invoice.id);
        throw new BadRequestException(
          "Erreur lors de la création des lignes de facture",
        );
      }
    }

    const createdInvoice = await this.findOne(userId, companyId, invoice.id);

    // Notifier via WebSocket
    this.websocketGateway.notifyInvoiceCreated(companyId, createdInvoice);

    return createdInvoice;
  }

  /**
   * Récupère la liste des factures d'une entreprise
   */
  async findAll(
    userId: string,
    companyId: string,
    query: InvoiceQueryDto,
  ): Promise<InvoiceListResponse> {
    const accessContext = await getUserCompanyAccessContext(userId, companyId);
    const role = accessContext.role;

    const supabase = getSupabaseAdmin();
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    // Requête de base
    let queryBuilder = supabase
      .from("invoices")
      .select(
        `
                *,
                client:clients(id, company_name, first_name, last_name, email)
            `,
        { count: "exact" },
      )
      .eq("company_id", companyId);

    // Filtre par statut
    if (query.status) {
      queryBuilder = queryBuilder.eq("status", query.status);
    }

    // Comptables : exclure les brouillons
    if (!canViewCompanyDraftDocuments(role, accessContext.companyOwnerRole)) {
      queryBuilder = queryBuilder.neq("status", "draft");
    }

    // Filtre par type
    if (query.type) {
      queryBuilder = queryBuilder.eq("type", query.type);
    } else {
      queryBuilder = queryBuilder.neq("type", "credit_note");
    }

    // Filtre par client
    if (query.client_id) {
      queryBuilder = queryBuilder.eq("client_id", query.client_id);
    }

    // Filtre par date
    if (query.from_date) {
      queryBuilder = queryBuilder.gte("issue_date", query.from_date);
    }
    if (query.to_date) {
      queryBuilder = queryBuilder.lte("issue_date", query.to_date);
    }

    // Filtre factures en retard
    if (query.overdue_only) {
      queryBuilder = queryBuilder
        .in("status", ["sent", "overdue"])
        .lt("due_date", new Date().toISOString().split("T")[0]);
    }

    // Recherche textuelle
    if (query.search) {
      queryBuilder = queryBuilder.or(
        `invoice_number.ilike.%${query.search}%,title.ilike.%${query.search}%`,
      );
    }

    // Pagination et tri
    queryBuilder = queryBuilder
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: invoices, error, count } = await queryBuilder;

    if (error) {
      console.error("Error fetching invoices:", error);
      throw new BadRequestException(
        "Erreur lors de la récupération des factures",
      );
    }

    const enrichedInvoices = await this.attachLinkedCreditNoteMetadata(
      companyId,
      (invoices || []) as Invoice[],
    );

    return {
      invoices: enrichedInvoices,
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    };
  }

  /**
   * Récupère une facture par son ID
   */
  async findOne(
    userId: string,
    companyId: string,
    invoiceId: string,
  ): Promise<Invoice> {
    const accessContext = await getUserCompanyAccessContext(userId, companyId);
    const role = accessContext.role;

    const supabase = getSupabaseAdmin();

    const { data: invoice, error } = await supabase
      .from("invoices")
      .select(
        `
                *,
                client:clients(*),
                company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, rib_iban, rib_bic, rib_bank_name, is_vat_exempt, vat_exemption_note),
                items:invoice_items(*),
                payments:payments(*),
                quote:quotes(id, quote_number, title)
            `,
      )
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (error || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    // Les comptables n'ont pas accès aux brouillons
    if (!canViewCompanyDraftDocuments(role, accessContext.companyOwnerRole) && invoice.status === "draft") {
      throw new ForbiddenException("Accès refusé aux brouillons");
    }

    // Trier les items par position
    if (invoice.items) {
      invoice.items.sort(
        (a: InvoiceItem, b: InvoiceItem) => a.position - b.position,
      );
    }

    // Trier les paiements par date
    if (invoice.payments) {
      invoice.payments.sort(
        (a: Payment, b: Payment) =>
          new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime(),
      );
    }

    // Récupérer les factures d'acompte si c'est une facture finale
    if (invoice.type === InvoiceType.FINAL && invoice.parent_invoice_id) {
      const { data: deposits } = await supabase
        .from("invoices")
        .select("id, invoice_number, total, amount_paid, status")
        .eq("parent_invoice_id", invoice.parent_invoice_id)
        .eq("type", InvoiceType.DEPOSIT);

      invoice.deposit_invoices = deposits || [];
    }

    const [enrichedInvoice] = await this.attachLinkedCreditNoteMetadata(
      companyId,
      [invoice as Invoice],
    );

    return enrichedInvoice;
  }

  /**
   * Récupère une facture par son token de signature (accès public)
   */
  async findBySignatureToken(token: string): Promise<Invoice> {
    const supabase = getSupabaseAdmin();

    const { data: invoice, error } = await supabase
      .from("invoices")
      .select(
        `
                *,
                client:clients(id, company_name, first_name, last_name, email, phone, address, postal_code, city),
                items:invoice_items(*),
                company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, rib_iban, rib_bic, rib_bank_name, is_vat_exempt, vat_exemption_note)
            `,
      )
      .eq("signature_token", token)
      .single();

    if (error || !invoice) {
      throw new NotFoundException("Facture non trouvée ou lien expiré");
    }

    // Vérifier l'expiration du token
    if (
      invoice.signature_token_expires_at &&
      new Date(invoice.signature_token_expires_at) < new Date()
    ) {
      throw new ForbiddenException("Le lien de signature a expiré");
    }

    // Vérifier le statut
    if (!["sent", "overdue"].includes(invoice.status)) {
      throw new ForbiddenException("Cette facture ne peut plus être signée");
    }

    // Marquer comme vue
    if (!invoice.viewed_at) {
      await supabase
        .from("invoices")
        .update({ viewed_at: new Date().toISOString() })
        .eq("id", invoice.id);
    }

    // Trier les items
    if (invoice.items) {
      invoice.items.sort(
        (a: InvoiceItem, b: InvoiceItem) => a.position - b.position,
      );
    }

    return invoice;
  }

  /**
   * Met à jour une facture
   */
  async update(
    userId: string,
    companyId: string,
    invoiceId: string,
    dto: UpdateInvoiceDto,
  ): Promise<Invoice> {
    await this.checkWriteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Vérifier que la facture existe et est modifiable
    const { data: existingInvoice, error: fetchError } = await supabase
      .from("invoices")
      .select("status, type")
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (fetchError || !existingInvoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    if (existingInvoice.type === "credit_note") {
      throw new ConflictException("Les avoirs ne peuvent pas être modifiés");
    }

    if (existingInvoice.status !== InvoiceStatus.DRAFT) {
      throw new ConflictException(
        "Seules les factures en brouillon peuvent être modifiées",
      );
    }

    // Vérifier le client si changé
    if (dto.client_id) {
      const { data: client, error: clientError } = await supabase
        .from("clients")
        .select("id")
        .eq("id", dto.client_id)
        .eq("company_id", companyId)
        .single();

      if (clientError || !client) {
        throw new BadRequestException("Client non trouvé");
      }
    }

    // Préparer les données
    const updateData: any = {};

    if (dto.client_id) updateData.client_id = dto.client_id;
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.subject !== undefined) updateData.subject = dto.subject;
    if (dto.issue_date) updateData.issue_date = dto.issue_date;
    if (dto.due_date) updateData.due_date = dto.due_date;
    if (dto.discount_type !== undefined)
      updateData.discount_type = dto.discount_type;
    if (dto.discount_value !== undefined)
      updateData.discount_value = dto.discount_value;
    if (dto.notes !== undefined) updateData.notes = dto.notes;
    if (dto.footer !== undefined) updateData.footer = dto.footer;
    if (dto.terms_and_conditions !== undefined)
      updateData.terms_and_conditions = dto.terms_and_conditions;
    if (dto.facturx_profile) updateData.facturx_profile = dto.facturx_profile;

    // Recalculer les totaux si items modifiés
    if (dto.items) {
      const normalizedItems = await this.normalizeItemsForCompanyVat(
        companyId,
        dto.items,
      );
      const { subtotal, total_vat, total, itemsWithTotals } =
        this.calculateTotals(normalizedItems, dto.discount_type, dto.discount_value);

      updateData.subtotal = subtotal;
      updateData.total_vat = total_vat;
      updateData.total = total;

      // Supprimer et recréer les lignes
      await supabase.from("invoice_items").delete().eq("invoice_id", invoiceId);

      if (itemsWithTotals.length > 0) {
        const invoiceItems = itemsWithTotals.map((item, index) => ({
          invoice_id: invoiceId,
          product_id: item.product_id || null,
          position: item.position ?? index,
          reference: item.reference || null,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit || null,
          unit_price: item.unit_price,
          vat_rate: item.vat_rate,
          discount_type: item.discount_type || null,
          discount_value: item.discount_value || 0,
          line_total: item.line_total,
        }));

        const { error: itemsError } = await supabase
          .from("invoice_items")
          .insert(invoiceItems);

        if (itemsError) {
          console.error("Error updating invoice items:", itemsError);
          throw new BadRequestException(
            "Erreur lors de la mise à jour des lignes",
          );
        }
      }
    }

    // Mettre à jour la facture
    if (Object.keys(updateData).length > 0) {
      const { error: updateError } = await supabase
        .from("invoices")
        .update(updateData)
        .eq("id", invoiceId);

      if (updateError) {
        console.error("Error updating invoice:", updateError);
        throw new BadRequestException(
          "Erreur lors de la mise à jour de la facture",
        );
      }
    }

    const updatedInvoice = await this.findOne(userId, companyId, invoiceId);

    // Notifier via WebSocket
    this.websocketGateway.notifyInvoiceUpdated(companyId, updatedInvoice);

    return updatedInvoice;
  }

  /**
   * Supprime une facture
   */
  async delete(
    userId: string,
    companyId: string,
    invoiceId: string,
  ): Promise<void> {
    await this.checkDeleteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select("status, type")
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (fetchError || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    if (invoice.type === "credit_note") {
      throw new ConflictException("Les avoirs ne peuvent pas être supprimés");
    }

    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new ConflictException(
        "Seules les factures en brouillon peuvent être supprimées",
      );
    }

    const { error } = await supabase
      .from("invoices")
      .delete()
      .eq("id", invoiceId);

    if (error) {
      console.error("Error deleting invoice:", error);
      throw new BadRequestException(
        "Erreur lors de la suppression de la facture",
      );
    }

    // Notifier via WebSocket
    this.websocketGateway.notifyInvoiceDeleted(companyId, invoiceId);
  }

  /**
   * Envoie une facture
   */
  async send(
    userId: string,
    companyId: string,
    invoiceId: string,
  ): Promise<Invoice & { warnings: string[] }> {
    await this.checkWriteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Récupérer la facture complète avec client et entreprise
    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select(
        `
                *,
                client:clients(*),
                company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, rib_iban, rib_bic, rib_bank_name, is_vat_exempt, vat_exemption_note),
                items:invoice_items(*)
            `,
      )
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (fetchError || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    if (
      ![
        InvoiceStatus.DRAFT,
        InvoiceStatus.SENT,
        InvoiceStatus.OVERDUE,
      ].includes(invoice.status as InvoiceStatus)
    ) {
      throw new ConflictException("Impossible d'envoyer cette facture");
    }

    // Vérifier que le client a un email
    if (!invoice.client?.email) {
      throw new BadRequestException(
        "Le client n'a pas d'adresse email configurée",
      );
    }

    // Générer un nouveau token de signature
    const signatureToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        status: InvoiceStatus.SENT,
        sent_at: new Date().toISOString(),
        signature_token: signatureToken,
        signature_token_expires_at: expiresAt,
      })
      .eq("id", invoiceId);

    if (updateError) {
      console.error("Error sending invoice:", updateError);
      throw new BadRequestException("Erreur lors de l'envoi de la facture");
    }

    // Mettre à jour le token dans l'objet pour l'email
    invoice.status = InvoiceStatus.SENT;
    invoice.sent_at = new Date().toISOString();
    invoice.signature_token = signatureToken;

    // Générer le PDF
    const warnings: string[] = [];
    let pdfBuffer: Buffer | undefined;
    try {
      pdfBuffer = (await this.pdfService.getOrCreateInvoicePdf(invoice, userId))
        .buffer;
    } catch (pdfError) {
      console.error("Error generating PDF:", pdfError);
      warnings.push(
        "Le PDF n'a pas pu être généré. L'email a été envoyé sans pièce jointe.",
      );
    }

    // Envoyer l'email
    if (this.notificationService.isEmailConfigured()) {
      try {
        const result = await this.notificationService.sendInvoiceEmailV2(
          invoice,
          invoice.client,
          invoice.company,
          pdfBuffer,
        );
        if (!result.success) {
          console.error("Error sending invoice email:", result.error);
          warnings.push("L'email n'a pas pu être envoyé.");
        }
      } catch (emailError) {
        console.error("Error sending invoice email:", emailError);
        warnings.push("L'email n'a pas pu être envoyé.");
      }
    }

    // Auto-submit à Chorus Pro si applicable
    try {
      await this.chorusProService.autoSubmitInvoice(
        companyId,
        invoiceId,
        invoice.client,
        userId,
      );
    } catch (chorusError) {
      console.error("Chorus Pro auto-submit failed:", chorusError);
      // Non-bloquant : l'envoi de facture continue
    }

    const updatedInvoice = await this.findOne(userId, companyId, invoiceId);

    // Notifier via WebSocket
    this.websocketGateway.notifyInvoiceStatusChanged(companyId, updatedInvoice);

    return { ...updatedInvoice, warnings };
  }

  /**
   * Signe une facture (accès public via token)
   */
  async sign(
    token: string,
    dto: SignInvoiceDto,
    ip: string,
    userAgent: string,
  ): Promise<{ invoice: Invoice; payment_link?: string }> {
    const supabase = getSupabaseAdmin();

    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select("*")
      .eq("signature_token", token)
      .single();

    if (fetchError || !invoice) {
      throw new NotFoundException("Facture non trouvée ou lien expiré");
    }

    if (
      invoice.signature_token_expires_at &&
      new Date(invoice.signature_token_expires_at) < new Date()
    ) {
      throw new ForbiddenException("Le lien de signature a expiré");
    }

    if (invoice.signed_at) {
      throw new ConflictException("Cette facture a déjà été signée");
    }

    if (!["sent", "overdue"].includes(invoice.status)) {
      throw new ForbiddenException("Cette facture ne peut plus être signée");
    }

    if (!dto.consent_accepted) {
      throw new BadRequestException(
        "Vous devez accepter les conditions pour signer",
      );
    }

    // Conserver le statut "sent" tout en stockant la signature
    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        status: InvoiceStatus.SENT,
        signed_at: new Date().toISOString(),
        signature_checkbox: true,
        signer_name: dto.signer_name,
        signer_ip: ip,
      })
      .eq("id", invoice.id);

    if (updateError) {
      console.error("Error signing invoice:", updateError);
      throw new BadRequestException(
        "Erreur lors de la signature de la facture",
      );
    }

    // Créer la signature
    const { error: sigError } = await supabase
      .from("invoice_signatures")
      .insert({
        invoice_id: invoice.id,
        signer_name: dto.signer_name,
        signer_email: dto.signer_email,
        ip_address: ip,
        user_agent: userAgent,
        document_hash: "",
        consent_text:
          "Je reconnais avoir lu et accepté les conditions de cette facture et m'engage à procéder au paiement.",
        consent_accepted: true,
      });

    if (sigError) {
      console.error("Error creating invoice signature:", sigError);
    }

    // TODO: Générer le lien de paiement Stripe

    const { data: updatedInvoice } = await supabase
      .from("invoices")
      .select(
        `
                *,
                client:clients(id, company_name, first_name, last_name, email),
                items:invoice_items(*)
            `,
      )
      .eq("id", invoice.id)
      .single();

    // Notifier via WebSocket que la facture a été signée
    this.websocketGateway.notifyInvoiceStatusChanged(
      invoice.company_id,
      updatedInvoice,
    );

    return {
      invoice: updatedInvoice,
      payment_link: undefined,
    };
  }

  /**
   * Enregistre un paiement manuel
   */
  async recordPayment(
    userId: string,
    companyId: string,
    invoiceId: string,
    dto: RecordPaymentDto,
  ): Promise<Invoice> {
    await this.checkWriteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Vérifier que la facture existe
    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select("status, total, amount_paid")
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (fetchError || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    if (["draft", "cancelled", "paid"].includes(invoice.status)) {
      throw new ConflictException(
        "Impossible d'enregistrer un paiement sur cette facture",
      );
    }

    const remainingAmount = invoice.total - (invoice.amount_paid || 0);
    if (dto.amount > remainingAmount) {
      throw new BadRequestException(
        `Le montant ne peut pas dépasser ${remainingAmount.toFixed(2)} €`,
      );
    }

    // Utiliser la fonction SQL pour enregistrer le paiement
    const { error: paymentError } = await supabase.rpc("record_payment", {
      p_invoice_id: invoiceId,
      p_amount: dto.amount,
      p_payment_method: dto.payment_method,
      p_reference: dto.reference || null,
      p_notes: dto.notes || null,
      p_created_by: userId,
    });

    if (paymentError) {
      console.error("Error recording payment:", paymentError);
      throw new BadRequestException(
        "Erreur lors de l'enregistrement du paiement",
      );
    }

    const updatedInvoice = await this.findOne(userId, companyId, invoiceId);

    // Notifier via WebSocket
    this.websocketGateway.notifyPaymentCreated(companyId, {
      invoice_id: invoiceId,
    });
    this.websocketGateway.notifyInvoiceStatusChanged(companyId, updatedInvoice);

    return updatedInvoice;
  }

  /**
   * Crée une facture d'acompte
   */
  async createDeposit(
    userId: string,
    companyId: string,
    invoiceId: string,
    dto: CreateDepositInvoiceDto,
  ): Promise<Invoice> {
    await this.checkWriteAccess(userId, companyId);

    // Récupérer la facture parente
    const parentInvoice = await this.findOne(userId, companyId, invoiceId);

    if (parentInvoice.type !== InvoiceType.STANDARD) {
      throw new ConflictException(
        "Impossible de créer un acompte sur ce type de facture",
      );
    }

    if (["paid", "cancelled", "overdue"].includes(parentInvoice.status)) {
      throw new ConflictException(
        "Impossible de créer un acompte sur cette facture",
      );
    }

    // Calculer le montant de l'acompte
    let depositAmount = dto.amount;
    if (dto.percentage) {
      depositAmount = parentInvoice.total * (dto.percentage / 100);
    }

    // Calculer le taux de TVA moyen
    const avgVatRate = (parentInvoice.total_vat / parentInvoice.subtotal) * 100;

    // Créer la facture d'acompte
    const depositDto: CreateInvoiceDto = {
      client_id: parentInvoice.client_id,
      type: InvoiceType.DEPOSIT,
      parent_invoice_id: invoiceId,
      title: `Acompte - ${parentInvoice.title || parentInvoice.invoice_number}`,
      due_date: dto.due_date,
      items: [
        {
          position: 0,
          description: `Acompte sur facture ${parentInvoice.invoice_number}`,
          quantity: 1,
          unit_price: depositAmount / (1 + avgVatRate / 100),
          vat_rate: avgVatRate,
        },
      ],
    };

    return this.create(userId, companyId, depositDto);
  }

  /**
   * Annule une facture
   */
  async cancel(
    userId: string,
    companyId: string,
    invoiceId: string,
    dto: CancelInvoiceDto,
  ): Promise<Invoice> {
    await this.checkDeleteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase.rpc(
      "cancel_invoice_with_optional_credit_note",
      {
        p_invoice_id: invoiceId,
        p_company_id: companyId,
        p_reason: dto.reason,
        p_create_credit_note: dto.create_credit_note || false,
        p_credit_note_amount: dto.credit_note_amount || null,
        p_user_id: userId,
      },
    );

    if (error) {
      this.throwInvoiceFlowError(
        error,
        "Erreur lors de l'annulation de la facture",
      );
    }

    const result = (data || {}) as CancelInvoiceRpcResult;

    const cancelledInvoice = await this.findOne(userId, companyId, invoiceId);

    let creditNote: Invoice | null = null;
    if (result.credit_note_id) {
      creditNote = await this.sendCreditNoteEmail(
        userId,
        companyId,
        result.credit_note_id,
      );
    }

    // Notifier via WebSocket
    this.websocketGateway.notifyInvoiceStatusChanged(
      companyId,
      cancelledInvoice,
    );

    if (creditNote) {
      this.websocketGateway.notifyInvoiceCreated(companyId, creditNote);
    }

    return cancelledInvoice;
  }

  /**
   * Crée un avoir pour une facture
   */
  async createCreditNote(
    userId: string,
    companyId: string,
    invoiceId: string,
    dto: CreateCreditNoteDto,
  ): Promise<Invoice> {
    await this.checkCreditNoteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase.rpc("create_credit_note_from_invoice", {
      p_invoice_id: invoiceId,
      p_company_id: companyId,
      p_user_id: userId,
      p_reason: dto.reason,
      p_amount: dto.amount || null,
    });

    if (error || !data) {
      this.throwInvoiceFlowError(
        error,
        "Erreur lors de la création de l'avoir",
      );
    }

    const fullCreditNote = await this.sendCreditNoteEmail(
      userId,
      companyId,
      data as string,
    );

    this.websocketGateway.notifyInvoiceCreated(companyId, fullCreditNote);

    return fullCreditNote;
  }

  /**
   * Récupère les statistiques de facturation
   */
  async getStats(
    userId: string,
    companyId: string,
    fromDate?: string,
    toDate?: string,
  ): Promise<InvoiceStats> {
    await this.checkCompanyAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    const from =
      fromDate ||
      new Date(new Date().getFullYear(), 0, 1).toISOString().split("T")[0];
    const to = toDate || new Date().toISOString().split("T")[0];

    const { data: periodInvoices, error: periodInvoicesError } = await supabase
      .from("invoices")
      .select("id, type, status, total, amount_paid, issue_date, due_date")
      .eq("company_id", companyId)
      .gte("issue_date", from)
      .lte("issue_date", to);

    if (periodInvoicesError) {
      console.error(
        "Error fetching invoice stats period invoices:",
        periodInvoicesError,
      );
      throw new BadRequestException(
        "Erreur lors de la récupération des statistiques de facturation",
      );
    }

    const { data: receivableInvoices, error: receivableInvoicesError } =
      await supabase
        .from("invoices")
        .select("id, type, status, total, amount_paid, issue_date, due_date")
        .eq("company_id", companyId);

    if (receivableInvoicesError) {
      console.error(
        "Error fetching invoice stats receivable invoices:",
        receivableInvoicesError,
      );
      throw new BadRequestException(
        "Erreur lors de la récupération des statistiques de facturation",
      );
    }

    const receivableInvoiceIds = (receivableInvoices || []).map(
      (invoice: { id: string }) => invoice.id,
    );

    let reminders: any[] = [];
    if (receivableInvoiceIds.length > 0) {
      const { data: reminderData, error: remindersError } = await supabase
        .from("reminders")
        .select(
          "invoice_id, status, type, level, sent_at, created_at, scheduled_at",
        )
        .eq("company_id", companyId)
        .in("invoice_id", receivableInvoiceIds);

      if (remindersError) {
        console.error("Error fetching invoice reminders for stats:", remindersError);
        throw new BadRequestException(
          "Erreur lors de la récupération des statistiques de facturation",
        );
      }

      reminders = reminderData || [];
    }

    const stats = computeInvoiceStats(
      periodInvoices || [],
      receivableInvoices || [],
      reminders,
    );

    return {
      total_invoiced: stats.totalInvoiced,
      total_paid: stats.totalPaid,
      total_pending: stats.totalPending,
      total_overdue: stats.totalOverdue,
      count_draft: stats.countDraft,
      count_sent: stats.countSent,
      count_paid: stats.countPaid,
      count_overdue: stats.countOverdue,
      total_invoiced_breakdown: stats.totalInvoicedBreakdown,
      total_paid_breakdown: stats.totalPaidBreakdown,
    };
  }

  /**
   * Récupère les paiements d'une facture
   */
  async getPayments(
    userId: string,
    companyId: string,
    invoiceId: string,
  ): Promise<Payment[]> {
    await this.checkCompanyAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Vérifier que la facture appartient à l'entreprise
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("id")
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (invoiceError || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    const { data: payments, error } = await supabase
      .from("payments")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("paid_at", { ascending: false });

    if (error) {
      console.error("Error fetching payments:", error);
      throw new BadRequestException(
        "Erreur lors de la récupération des paiements",
      );
    }

    return payments || [];
  }

  /**
   * Formate une facture pour la génération PDF
   */
  formatForPdf(invoice: any): any {
    return this.pdfService.formatInvoiceForPdf(invoice);
  }

  /**
   * Renvoyer l'email de la facture
   */
  async resendEmail(
    userId: string,
    companyId: string,
    invoiceId: string,
  ): Promise<{ success: boolean; message: string; warning?: string }> {
    await this.checkWriteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Récupérer la facture complète
    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select(
        `
                *,
                client:clients(*),
                company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, rib_iban, rib_bic, rib_bank_name, is_vat_exempt, vat_exemption_note),
                items:invoice_items(*)
            `,
      )
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (fetchError || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new BadRequestException(
        "Impossible de renvoyer une facture en brouillon. Envoyez-la d'abord.",
      );
    }

    if (!invoice.client?.email) {
      throw new BadRequestException(
        "Le client n'a pas d'adresse email configurée",
      );
    }

    // Générer le PDF
    let pdfBuffer: Buffer | undefined;
    let warning: string | undefined;
    try {
      pdfBuffer = (await this.pdfService.getOrCreateInvoicePdf(invoice, userId))
        .buffer;
    } catch (pdfError) {
      console.error("Error generating PDF:", pdfError);
      warning =
        "Le PDF n'a pas pu être généré. L'email a été envoyé sans pièce jointe.";
    }

    // Envoyer l'email
    if (!this.notificationService.isEmailConfigured()) {
      throw new BadRequestException("Le service d'email n'est pas configuré");
    }

    const result = await this.notificationService.sendInvoiceEmailV2(
      invoice,
      invoice.client,
      invoice.company,
      pdfBuffer,
    );

    if (!result.success) {
      throw new BadRequestException(
        result.error || "Erreur lors de l'envoi de l'email",
      );
    }

    return { success: true, message: "Email renvoyé avec succès", warning };
  }

  /**
   * Envoyer une relance de paiement
   */
  async sendReminder(
    userId: string,
    companyId: string,
    invoiceId: string,
    dto: { level?: number; custom_message?: string; include_pdf?: boolean },
  ): Promise<{ success: boolean; message: string; warning?: string }> {
    await this.checkWriteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Récupérer la facture complète
    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select(
        `
                *,
                client:clients(*),
                company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, rib_iban, rib_bic, rib_bank_name, is_vat_exempt, vat_exemption_note),
                items:invoice_items(*)
            `,
      )
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (fetchError || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    if (!["sent", "overdue"].includes(invoice.status)) {
      throw new BadRequestException(
        "Impossible d'envoyer une relance pour cette facture",
      );
    }

    if (!invoice.client?.email) {
      throw new BadRequestException(
        "Le client n'a pas d'adresse email configurée",
      );
    }

    // Vérifier que la facture n'est pas entièrement payée
    if (invoice.amount_paid >= invoice.total) {
      throw new BadRequestException("Cette facture est déjà entièrement payée");
    }

    // Générer le PDF si demandé
    let pdfBuffer: Buffer | undefined;
    let warning: string | undefined;
    if (dto.include_pdf !== false) {
      try {
        pdfBuffer = (
          await this.pdfService.getOrCreateInvoicePdf(invoice, userId)
        ).buffer;
      } catch (pdfError) {
        console.error("Error generating PDF:", pdfError);
        warning =
          "Le PDF n'a pas pu être généré. L'email a été envoyé sans pièce jointe.";
      }
    }

    // Envoyer la relance
    if (!this.notificationService.isEmailConfigured()) {
      throw new BadRequestException("Le service d'email n'est pas configuré");
    }

    const level = (dto.level || 1) as 1 | 2 | 3;
    const result = await this.notificationService.sendInvoiceReminderV2(
      invoice,
      invoice.client,
      invoice.company,
      level,
      pdfBuffer,
    );

    if (!result.success) {
      throw new BadRequestException(
        result.error || "Erreur lors de l'envoi de la relance",
      );
    }

    const now = new Date().toISOString();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueDate = invoice.due_date ? new Date(invoice.due_date) : null;
    if (dueDate) {
      dueDate.setHours(0, 0, 0, 0);
    }

    const reminderType =
      dueDate && dueDate < today ? "after_due" : "before_due";

    const { error: reminderError } = await supabase.from("reminders").insert({
      company_id: companyId,
      invoice_id: invoiceId,
      client_id: invoice.client_id,
      type: reminderType,
      channel: "email",
      status: "sent",
      level,
      scheduled_at: now,
      sent_at: now,
      email_message_id: result.message_id || null,
    });

    if (reminderError) {
      console.error("Error recording invoice reminder:", reminderError);
      warning = warning
        ? `${warning} L'historique de relance n'a pas pu être enregistré.`
        : "La relance a été envoyée, mais l'historique n'a pas pu être enregistré.";
    }

    return {
      success: true,
      message: `Relance niveau ${level} envoyée avec succès`,
      warning,
    };
  }

  /**
   * Marquer une facture comme payée (paiement en espèces/hors système)
   */
  async markAsPaid(
    userId: string,
    companyId: string,
    invoiceId: string,
    data: { payment_method?: string; reference?: string; notes?: string },
  ): Promise<Invoice> {
    await this.checkWriteAccess(userId, companyId);

    const supabase = getSupabaseAdmin();

    // Récupérer la facture
    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .single();

    if (fetchError || !invoice) {
      throw new NotFoundException("Facture non trouvée");
    }

    if (!["sent", "overdue"].includes(invoice.status)) {
      throw new BadRequestException(
        "Impossible de marquer cette facture comme payée",
      );
    }

    const remainingAmount = invoice.total - (invoice.amount_paid || 0);
    if (remainingAmount <= 0) {
      throw new BadRequestException("Cette facture est déjà entièrement payée");
    }

    // Créer l'enregistrement de paiement
    const paymentData = {
      invoice_id: invoiceId,
      amount: remainingAmount,
      payment_method: data.payment_method || "cash",
      reference: data.reference || `CASH-${Date.now()}`,
      notes: data.notes || "Paiement manuel (espèces/hors système)",
      paid_at: new Date().toISOString(),
      created_by: userId,
    };

    const { error: paymentError } = await supabase
      .from("payments")
      .insert(paymentData);

    if (paymentError) {
      console.error("Error creating payment:", paymentError);
      throw new BadRequestException("Erreur lors de la création du paiement");
    }

    // Mettre à jour la facture
    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        status: InvoiceStatus.PAID,
        amount_paid: invoice.total,
        paid_at: new Date().toISOString(),
        payment_method: data.payment_method || "cash",
      })
      .eq("id", invoiceId);

    if (updateError) {
      console.error("Error updating invoice:", updateError);
      throw new BadRequestException(
        "Erreur lors de la mise à jour de la facture",
      );
    }

    const updatedInvoice = await this.findOne(userId, companyId, invoiceId);

    // Notifier via WebSocket
    this.websocketGateway.notifyPaymentCreated(companyId, {
      invoice_id: invoiceId,
      amount: remainingAmount,
    });
    this.websocketGateway.notifyInvoiceStatusChanged(companyId, updatedInvoice);

    return updatedInvoice;
  }
}
