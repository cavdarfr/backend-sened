import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { getSupabaseAdmin } from '../../config/supabase.config';
import {
    CreateQuoteDto,
    UpdateQuoteDto,
    QuoteQueryDto,
    SendQuoteDto,
    SignQuoteDto,
    RefuseQuoteDto,
    Quote,
    PublicQuote,
    PublicQuoteTerms,
    QuoteItem,
    QuoteListResponse,
    QuoteStatus,
    QuoteItemDto,
    QuoteSignatureProvider,
    SendQuoteResponse,
    QuoteSignatureDocument,
    QuoteSignatureDocumentKind,
} from './dto/quote.dto';
import { buildQuoteSignUrl } from './quote-links.util';
import { NotificationService } from '../reminder/notification.service';
import { PdfService } from '../pdf/pdf.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { LegalDocumentService } from '../legal-document/legal-document.service';
import {
    getUserCompanyRole,
    getUserCompanyAccessContext,
    canDeleteCompanyDocuments,
    canReadCompanyDocuments,
    canWriteCompanyDocuments,
    CompanyRole,
} from '../../common/roles/roles';

export function buildQuoteTokenExpiryFromValidityDate(validityDate: string): string {
    const date = new Date(`${validityDate}T23:59:59.999+01:00`);
    return date.toISOString();
}

@Injectable()
export class QuoteService {
    private readonly publicQuoteSelect = `
        *,
        client:clients(
            id,
            type,
            company_name,
            first_name,
            last_name,
            email,
            phone,
            signature_contact_first_name,
            signature_contact_last_name,
            signature_contact_email,
            signature_contact_phone,
            address,
            postal_code,
            city
        ),
        items:quote_items(*),
        company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, is_vat_exempt, vat_exemption_note)
    `;

    constructor(
        private readonly configService: ConfigService,
        private readonly notificationService: NotificationService,
        private readonly pdfService: PdfService,
        private readonly websocketGateway: WebsocketGateway,
        private readonly legalDocumentService: LegalDocumentService,
    ) {}

    private async checkCompanyAccess(userId: string, companyId: string): Promise<CompanyRole> {
        return getUserCompanyRole(userId, companyId);
    }

    private async checkWriteAccess(userId: string, companyId: string): Promise<CompanyRole> {
        const accessContext = await getUserCompanyAccessContext(userId, companyId);

        if (!canWriteCompanyDocuments(accessContext.role, accessContext.companyOwnerRole)) {
            throw new ForbiddenException(
                "Vous n'avez pas les permissions nécessaires pour cette action",
            );
        }

        return accessContext.role;
    }

    private async checkReadAccess(userId: string, companyId: string): Promise<CompanyRole> {
        const accessContext = await getUserCompanyAccessContext(userId, companyId);

        if (!canReadCompanyDocuments(accessContext.role, accessContext.companyOwnerRole)) {
            throw new ForbiddenException(
                "Vous n'avez pas les permissions nécessaires pour cette action",
            );
        }

        return accessContext.role;
    }

    private async checkDeleteAccess(userId: string, companyId: string): Promise<CompanyRole> {
        const accessContext = await getUserCompanyAccessContext(userId, companyId);

        if (!canDeleteCompanyDocuments(accessContext.role, accessContext.companyOwnerRole)) {
            throw new ForbiddenException(
                "Vous n'avez pas les permissions nécessaires pour cette action",
            );
        }

        return accessContext.role;
    }

    private isSignatureTokenExpired(quote: { signature_token_expires_at?: string | null }): boolean {
        return Boolean(
            quote.signature_token_expires_at &&
            new Date(quote.signature_token_expires_at) < new Date(),
        );
    }

    private canRespondToPublicQuote(quote: { status: string; signature_token_expires_at?: string | null }): boolean {
        return ['sent', 'viewed'].includes(quote.status) && !this.isSignatureTokenExpired(quote);
    }

    private getQuotePublicUrl(token: string): string {
        const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173').replace(/\/+$/, '');
        return buildQuoteSignUrl(base, token);
    }

    private toQuoteTokenExpiry(validityDate: string): string {
        return buildQuoteTokenExpiryFromValidityDate(validityDate);
    }

    private buildQuoteDocumentHash(quote: any): string {
        const payload = {
            id: quote.id,
            quote_number: quote.quote_number,
            company_id: quote.company_id,
            client_id: quote.client_id,
            issue_date: quote.issue_date,
            validity_date: quote.validity_date,
            subtotal: quote.subtotal,
            total_vat: quote.total_vat,
            total: quote.total,
            discount_type: quote.discount_type,
            discount_value: quote.discount_value,
            notes: quote.notes,
            terms: quote.terms,
            terms_and_conditions: quote.terms_and_conditions,
            terms_checksum_sha256: quote.terms_checksum_sha256,
            items: (quote.items || []).map((item: any) => ({
                description: item.description,
                quantity: item.quantity,
                unit_price: item.unit_price,
                vat_rate: item.vat_rate,
                line_total: item.line_total,
            })),
        };

        return crypto
            .createHash('sha256')
            .update(JSON.stringify(payload), 'utf8')
            .digest('hex');
    }

    private normalizePublicQuote(quote: any): PublicQuote {
        if (quote.items) {
            quote.items.sort((a: QuoteItem, b: QuoteItem) => a.position - b.position);
        }

        const canRespond = this.canRespondToPublicQuote(quote);
        const hasTermsSnapshot = Boolean(quote.terms_and_conditions?.trim());

        return {
            ...quote,
            is_signature_link_expired: this.isSignatureTokenExpired(quote),
            can_sign: canRespond,
            can_refuse: canRespond,
            can_start_signature: false,
            has_terms_snapshot: hasTermsSnapshot,
            terms_public_url:
                hasTermsSnapshot && quote.signature_token
                    ? `/quotes/sign/${quote.signature_token}/terms`
                    : null,
        };
    }

    private async getPublicQuoteByToken(token: string): Promise<PublicQuote> {
        const supabase = getSupabaseAdmin();

        const { data: quote, error } = await supabase
            .from('quotes')
            .select(this.publicQuoteSelect)
            .eq('signature_token', token)
            .single();

        if (error || !quote) {
            throw new NotFoundException('Devis non trouvé ou lien expiré');
        }

        return this.normalizePublicQuote(quote);
    }

    /**
     * Calcule les totaux d'un devis à partir des lignes
     */
    private calculateTotals(items: QuoteItemDto[], globalDiscountType?: string, globalDiscountValue?: number): {
        subtotal: number;
        total_vat: number;
        total: number;
        itemsWithTotals: (QuoteItemDto & { line_total: number })[];
    } {
        let subtotal = 0;
        let totalVat = 0;

        const itemsWithTotals = items.map(item => {
            let lineSubtotal = item.quantity * item.unit_price;

            // Appliquer la remise de ligne
            if (item.discount_type && item.discount_value) {
                if (item.discount_type === 'percentage') {
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
            if (globalDiscountType === 'percentage') {
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
        items: QuoteItemDto[],
    ): Promise<QuoteItemDto[]> {
        const supabase = getSupabaseAdmin();
        const { data: company } = await supabase
            .from('companies')
            .select('is_vat_exempt')
            .eq('id', companyId)
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
     * Génère le numéro de devis
     */
    private async generateQuoteNumber(companyId: string): Promise<string> {
        const supabase = getSupabaseAdmin();

        const { data, error } = await supabase.rpc('generate_document_number', {
            p_company_id: companyId,
            p_type: 'quote',
        });

        if (error) {
            console.error('Error generating quote number:', error);
            throw new BadRequestException('Erreur lors de la génération du numéro de devis');
        }

        return data;
    }

    /**
     * Crée un nouveau devis
     */
    async create(userId: string, companyId: string, dto: CreateQuoteDto): Promise<Quote> {
        await this.checkWriteAccess(userId, companyId);

        const supabase = getSupabaseAdmin();
        const publishedCompanyTerms = await this.legalDocumentService.getPublishedCompanySalesTerms(companyId);

        // Vérifier que le client existe et appartient à l'entreprise
        const { data: client, error: clientError } = await supabase
            .from('clients')
            .select('id')
            .eq('id', dto.client_id)
            .eq('company_id', companyId)
            .single();

        if (clientError || !client) {
            throw new BadRequestException('Client non trouvé');
        }

        // Récupérer les paramètres de l'entreprise
        const { data: settings } = await supabase
            .from('document_settings')
            .select('default_quote_validity_days')
            .eq('company_id', companyId)
            .single();

        const validityDays = settings?.default_quote_validity_days || 30;

        // Calculer les totaux
        const normalizedItems = await this.normalizeItemsForCompanyVat(companyId, dto.items);
        const { subtotal, total_vat, total, itemsWithTotals } = this.calculateTotals(
            normalizedItems,
            dto.discount_type,
            dto.discount_value,
        );

        // Générer le numéro de devis
        const quoteNumber = await this.generateQuoteNumber(companyId);

        // Calculer les dates
        const issueDate = dto.issue_date || new Date().toISOString().split('T')[0];
        const validityDate = dto.validity_date || 
            new Date(new Date(issueDate).getTime() + validityDays * 24 * 60 * 60 * 1000)
                .toISOString().split('T')[0];

        // Créer le devis
        const { data: quote, error: quoteError } = await supabase
            .from('quotes')
            .insert({
                company_id: companyId,
                client_id: dto.client_id,
                created_by: userId,
                quote_number: quoteNumber,
                status: QuoteStatus.DRAFT,
                title: dto.title || null,
                subject: dto.subject || null,
                introduction: dto.introduction || null,
                issue_date: issueDate,
                validity_date: validityDate,
                subtotal,
                total_vat,
                total,
                discount_type: dto.discount_type || null,
                discount_value: dto.discount_value || 0,
                notes: dto.notes || null,
                terms: dto.terms || null,
                terms_and_conditions:
                    dto.terms_and_conditions !== undefined
                        ? dto.terms_and_conditions || null
                        : publishedCompanyTerms?.version.content_text || null,
            })
            .select()
            .single();

        if (quoteError) {
            console.error('Error creating quote:', quoteError);
            throw new BadRequestException('Erreur lors de la création du devis');
        }

        // Créer les lignes du devis
        if (itemsWithTotals.length > 0) {
            const quoteItems = itemsWithTotals.map((item, index) => ({
                quote_id: quote.id,
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
                .from('quote_items')
                .insert(quoteItems);

            if (itemsError) {
                console.error('Error creating quote items:', itemsError);
                // Supprimer le devis créé en cas d'erreur
                await supabase.from('quotes').delete().eq('id', quote.id);
                throw new BadRequestException('Erreur lors de la création des lignes du devis');
            }
        }

        // Récupérer le devis complet avec les lignes
        const createdQuote = await this.findOne(userId, companyId, quote.id);
        
        // Notifier via WebSocket
        this.websocketGateway.notifyQuoteCreated(companyId, createdQuote);
        
        return createdQuote;
    }

    /**
     * Récupère la liste des devis d'une entreprise
     */
    async findAll(userId: string, companyId: string, query: QuoteQueryDto): Promise<QuoteListResponse> {
        await this.checkReadAccess(userId, companyId);

        const supabase = getSupabaseAdmin();
        const page = query.page || 1;
        const limit = query.limit || 20;
        const offset = (page - 1) * limit;

        // Requête de base
        let queryBuilder = supabase
            .from('quotes')
            .select(`
                *,
                client:clients(id, company_name, first_name, last_name, email)
            `, { count: 'exact' })
            .eq('company_id', companyId);

        // Filtre par statut
        if (query.status) {
            queryBuilder = queryBuilder.eq('status', query.status);
        }

        // Filtre par client
        if (query.client_id) {
            queryBuilder = queryBuilder.eq('client_id', query.client_id);
        }

        // Filtre par date
        if (query.from_date) {
            queryBuilder = queryBuilder.gte('issue_date', query.from_date);
        }
        if (query.to_date) {
            queryBuilder = queryBuilder.lte('issue_date', query.to_date);
        }

        // Recherche textuelle
        if (query.search) {
            queryBuilder = queryBuilder.or(
                `quote_number.ilike.%${query.search}%,title.ilike.%${query.search}%`
            );
        }

        // Pagination et tri
        queryBuilder = queryBuilder
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        const { data: quotes, error, count } = await queryBuilder;

        if (error) {
            console.error('Error fetching quotes:', error);
            throw new BadRequestException('Erreur lors de la récupération des devis');
        }

        return {
            quotes: quotes || [],
            total: count || 0,
            page,
            limit,
            totalPages: Math.ceil((count || 0) / limit),
        };
    }

    /**
     * Récupère un devis par son ID
     */
    async findOne(userId: string, companyId: string, quoteId: string): Promise<Quote> {
        await this.checkReadAccess(userId, companyId);

        return this.getQuoteDetailsById(quoteId, companyId);
    }

    private async getQuoteDetailsById(quoteId: string, companyId?: string): Promise<Quote> {
        const supabase = getSupabaseAdmin();

        let query = supabase
            .from('quotes')
            .select(`
                *,
                client:clients(*),
                company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, is_vat_exempt, vat_exemption_note),
                items:quote_items(*)
            `)
            .eq('id', quoteId);

        if (companyId) {
            query = query.eq('company_id', companyId);
        }

        const { data: quote, error } = await query.single();

        if (error || !quote) {
            throw new NotFoundException('Devis non trouvé');
        }

        // Trier les items par position
        if (quote.items) {
            quote.items.sort((a: QuoteItem, b: QuoteItem) => a.position - b.position);
        }

        return quote;
    }

    /**
     * Récupère un devis par son token de signature (accès public)
     */
    async findBySignatureToken(token: string): Promise<PublicQuote> {
        const supabase = getSupabaseAdmin();
        const quote = await this.getPublicQuoteByToken(token);

        // Marquer comme vu uniquement si le devis est encore actif et actionnable.
        if (!quote.viewed_at && quote.status === QuoteStatus.SENT && !quote.is_signature_link_expired) {
            const viewedAt = new Date().toISOString();

            await supabase
                .from('quotes')
                .update({
                    viewed_at: viewedAt,
                    status: QuoteStatus.VIEWED,
                })
                .eq('id', quote.id);

            quote.viewed_at = viewedAt;
            quote.status = QuoteStatus.VIEWED;
            quote.can_sign = true;
            quote.can_refuse = true;
        }

        return quote;
    }

    async getTermsBySignatureToken(token: string): Promise<PublicQuoteTerms> {
        const quote = await this.getPublicQuoteByToken(token);
        const hasTermsSnapshot = Boolean(quote.terms_and_conditions?.trim());

        return {
            quote_number: quote.quote_number,
            company: quote.company
                ? {
                    name: quote.company.name || null,
                    legal_name: quote.company.legal_name || null,
                }
                : null,
            has_terms_snapshot: hasTermsSnapshot,
            legal_document_version_number: quote.legal_document_version_number || null,
            terms_and_conditions: hasTermsSnapshot ? quote.terms_and_conditions || null : null,
            terms_checksum_sha256: hasTermsSnapshot ? quote.terms_checksum_sha256 || null : null,
        };
    }

    private getQuoteSignatureDocumentKind(filename: string, storagePath?: string | null): QuoteSignatureDocumentKind | null {
        const normalizedPath = `${storagePath || ''}/${filename}`.toLowerCase();

        if (normalizedPath.includes('audit-trail')) {
            return 'audit_trail';
        }

        if (normalizedPath.includes('-signed.pdf')) {
            return 'signed_quote';
        }

        return null;
    }

    async getSignatureDocuments(userId: string, companyId: string, quoteId: string): Promise<QuoteSignatureDocument[]> {
        await this.checkReadAccess(userId, companyId);

        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase
            .from('documents')
            .select('id, filename, mime_type, created_at, storage_path')
            .eq('company_id', companyId)
            .eq('type', 'signature')
            .eq('related_type', 'quote')
            .eq('related_id', quoteId)
            .order('created_at', { ascending: false });

        if (error) {
            throw new BadRequestException(error.message);
        }

        return (data || [])
            .map((document: any) => {
                const kind = this.getQuoteSignatureDocumentKind(document.filename, document.storage_path);
                if (!kind) {
                    return null;
                }

                return {
                    id: document.id,
                    filename: document.filename,
                    mime_type: document.mime_type || 'application/pdf',
                    created_at: document.created_at,
                    kind,
                } satisfies QuoteSignatureDocument;
            })
            .filter((document: QuoteSignatureDocument | null): document is QuoteSignatureDocument => Boolean(document));
    }

    async downloadSignatureDocument(userId: string, companyId: string, quoteId: string, documentId: string) {
        await this.checkReadAccess(userId, companyId);

        const supabase = getSupabaseAdmin();
        const { data: document, error } = await supabase
            .from('documents')
            .select('id, filename, mime_type, storage_path')
            .eq('id', documentId)
            .eq('company_id', companyId)
            .eq('type', 'signature')
            .eq('related_type', 'quote')
            .eq('related_id', quoteId)
            .maybeSingle();

        if (error && error.code !== 'PGRST116') {
            throw new BadRequestException(error.message);
        }

        if (!document?.storage_path) {
            throw new NotFoundException('Document de signature introuvable');
        }

        const { data: fileData, error: downloadError } = await supabase.storage
            .from(process.env.STORAGE_DOCUMENTS_BUCKET || 'documents')
            .download(document.storage_path);

        if (downloadError || !fileData) {
            throw new NotFoundException('Le document stocké est introuvable dans le storage');
        }

        return {
            buffer: Buffer.from(await fileData.arrayBuffer()),
            filename: document.filename,
            mimeType: document.mime_type || 'application/pdf',
        };
    }

    /**
     * Met à jour un devis
     */
    async update(userId: string, companyId: string, quoteId: string, dto: UpdateQuoteDto): Promise<Quote> {
        await this.checkWriteAccess(userId, companyId);

        const supabase = getSupabaseAdmin();

        // Vérifier que le devis existe et est modifiable
        const { data: existingQuote, error: fetchError } = await supabase
            .from('quotes')
            .select('status')
            .eq('id', quoteId)
            .eq('company_id', companyId)
            .single();

        if (fetchError || !existingQuote) {
            throw new NotFoundException('Devis non trouvé');
        }

        if (existingQuote.status !== QuoteStatus.DRAFT) {
            throw new ConflictException('Seuls les devis en brouillon peuvent être modifiés');
        }

        // Si on met à jour le client, vérifier qu'il existe
        if (dto.client_id) {
            const { data: client, error: clientError } = await supabase
                .from('clients')
                .select('id')
                .eq('id', dto.client_id)
                .eq('company_id', companyId)
                .single();

            if (clientError || !client) {
                throw new BadRequestException('Client non trouvé');
            }
        }

        // Préparer les données de mise à jour
        const updateData: any = {};
        
        if (dto.client_id) updateData.client_id = dto.client_id;
        if (dto.title !== undefined) updateData.title = dto.title;
        if (dto.subject !== undefined) updateData.subject = dto.subject;
        if (dto.introduction !== undefined) updateData.introduction = dto.introduction;
        if (dto.issue_date) updateData.issue_date = dto.issue_date;
        if (dto.validity_date) updateData.validity_date = dto.validity_date;
        if (dto.discount_type !== undefined) updateData.discount_type = dto.discount_type;
        if (dto.discount_value !== undefined) updateData.discount_value = dto.discount_value;
        if (dto.notes !== undefined) updateData.notes = dto.notes;
        if (dto.terms !== undefined) updateData.terms = dto.terms;
        if (dto.terms_and_conditions !== undefined) updateData.terms_and_conditions = dto.terms_and_conditions;

        // Si on met à jour les lignes, recalculer les totaux
        if (dto.items) {
            const normalizedItems = await this.normalizeItemsForCompanyVat(companyId, dto.items);
            const { subtotal, total_vat, total, itemsWithTotals } = this.calculateTotals(
                normalizedItems,
                dto.discount_type,
                dto.discount_value,
            );

            updateData.subtotal = subtotal;
            updateData.total_vat = total_vat;
            updateData.total = total;

            // Supprimer les anciennes lignes
            await supabase.from('quote_items').delete().eq('quote_id', quoteId);

            // Créer les nouvelles lignes
            if (itemsWithTotals.length > 0) {
                const quoteItems = itemsWithTotals.map((item, index) => ({
                    quote_id: quoteId,
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
                    .from('quote_items')
                    .insert(quoteItems);

                if (itemsError) {
                    console.error('Error updating quote items:', itemsError);
                    throw new BadRequestException('Erreur lors de la mise à jour des lignes');
                }
            }
        }

        // Mettre à jour le devis
        if (Object.keys(updateData).length > 0) {
            const { error: updateError } = await supabase
                .from('quotes')
                .update(updateData)
                .eq('id', quoteId);

            if (updateError) {
                console.error('Error updating quote:', updateError);
                throw new BadRequestException('Erreur lors de la mise à jour du devis');
            }
        }

        const updatedQuote = await this.findOne(userId, companyId, quoteId);
        
        // Notifier via WebSocket
        this.websocketGateway.notifyQuoteUpdated(companyId, updatedQuote);

        return updatedQuote;
    }

    /**
     * Supprime un devis
     */
    async delete(userId: string, companyId: string, quoteId: string): Promise<void> {
        await this.checkDeleteAccess(userId, companyId);

        const supabase = getSupabaseAdmin();

        // Vérifier que le devis existe et est supprimable
        const { data: quote, error: fetchError } = await supabase
            .from('quotes')
            .select('status')
            .eq('id', quoteId)
            .eq('company_id', companyId)
            .single();

        if (fetchError || !quote) {
            throw new NotFoundException('Devis non trouvé');
        }

        if (quote.status !== QuoteStatus.DRAFT) {
            throw new ConflictException('Seuls les devis en brouillon peuvent être supprimés');
        }

        const { error } = await supabase
            .from('quotes')
            .delete()
            .eq('id', quoteId);

        if (error) {
            console.error('Error deleting quote:', error);
            throw new BadRequestException('Erreur lors de la suppression du devis');
        }

        // Notifier via WebSocket
        this.websocketGateway.notifyQuoteDeleted(companyId, quoteId);
    }

    /**
     * Duplique un devis
     */
    async duplicate(userId: string, companyId: string, quoteId: string): Promise<Quote> {
        await this.checkWriteAccess(userId, companyId);

        // Récupérer le devis original
        const originalQuote = await this.findOne(userId, companyId, quoteId);

        // Récupérer les paramètres
        const supabase = getSupabaseAdmin();
        const { data: settings } = await supabase
            .from('document_settings')
            .select('default_quote_validity_days')
            .eq('company_id', companyId)
            .single();

        const validityDays = settings?.default_quote_validity_days || 30;
        const issueDate = new Date().toISOString().split('T')[0];
        const validityDate = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000)
            .toISOString().split('T')[0];

        // Créer le nouveau devis
        const createDto: CreateQuoteDto = {
            client_id: originalQuote.client_id,
            title: originalQuote.title ?? undefined,
            introduction: originalQuote.introduction || undefined,
            issue_date: issueDate,
            validity_date: validityDate,
            discount_type: originalQuote.discount_type || undefined,
            discount_value: originalQuote.discount_value || undefined,
            notes: originalQuote.notes || undefined,
            terms: originalQuote.terms || undefined,
            terms_and_conditions: originalQuote.terms_and_conditions || undefined,
            items: (originalQuote.items || []).map(item => ({
                product_id: item.product_id || undefined,
                position: item.position,
                reference: item.reference || undefined,
                description: item.description,
                quantity: item.quantity,
                unit: item.unit || undefined,
                unit_price: item.unit_price,
                vat_rate: item.vat_rate,
                discount_type: item.discount_type || undefined,
                discount_value: item.discount_value || undefined,
            })),
        };

        return this.create(userId, companyId, createDto);
    }

    /**
     * Envoie un devis (change le statut et génère le lien de signature)
     */
    async send(
        userId: string,
        companyId: string,
        quoteId: string,
        dto: SendQuoteDto = {},
    ): Promise<SendQuoteResponse> {
        await this.checkWriteAccess(userId, companyId);

        const supabase = getSupabaseAdmin();

        // Récupérer le devis complet avec client et entreprise
        const { data: quote, error: fetchError } = await supabase
            .from('quotes')
            .select(`
                *,
                client:clients(*),
                company:companies(id, name, legal_name, siren, vat_number, address, city, postal_code, phone, email, logo_url, is_vat_exempt, vat_exemption_note),
                items:quote_items(*)
            `)
            .eq('id', quoteId)
            .eq('company_id', companyId)
            .single();

        if (fetchError || !quote) {
            throw new NotFoundException('Devis non trouvé');
        }

        if (quote.status !== QuoteStatus.DRAFT) {
            throw new ConflictException('Ce devis a déjà été envoyé');
        }

        // Vérifier que le client a un email
        if (!quote.client?.email) {
            throw new BadRequestException("Le client n'a pas d'adresse email configurée");
        }

        const signatureToken = crypto.randomUUID();
        const tokenExpiresAt = this.toQuoteTokenExpiry(quote.validity_date);
        const publishedCompanyTerms = await this.legalDocumentService.getPublishedCompanySalesTerms(companyId);
        const quoteTerms = quote.terms_and_conditions?.trim() || '';
        const publishedTerms = publishedCompanyTerms?.version.content_text?.trim() || '';

        let legalVersion: Awaited<ReturnType<LegalDocumentService['resolveQuoteTermsVersion']>> | null = null;
        let resolvedTerms: string | null = null;

        if (quoteTerms) {
            legalVersion = await this.legalDocumentService.resolveQuoteTermsVersion(
                companyId,
                quote.terms_and_conditions,
                userId,
                quoteId,
            );
            resolvedTerms = legalVersion?.content_text || quoteTerms;
        } else if (publishedTerms && publishedCompanyTerms) {
            legalVersion = {
                document: publishedCompanyTerms.document,
                version: publishedCompanyTerms.version,
                content_text: publishedCompanyTerms.version.content_text,
                checksum_sha256: publishedCompanyTerms.version.checksum_sha256,
            };
            resolvedTerms = publishedCompanyTerms.version.content_text;
        } else if (!dto.confirm_send_without_cgv) {
            throw new BadRequestException(
                "Confirmez l'envoi sans CGV pour envoyer ce devis sans CGV publiées ou texte de CGV sur le devis",
            );
        }

        quote.signature_token = signatureToken;
        quote.signature_token_expires_at = tokenExpiresAt;
        quote.terms_and_conditions = resolvedTerms;
        quote.legal_document_version_id = legalVersion?.version.id || null;
        quote.legal_document_version_number = legalVersion?.version.version_number || null;
        quote.terms_checksum_sha256 = legalVersion?.checksum_sha256 || null;

        const pdfData = this.formatForPdf(quote);
        const pdfBuffer = await this.pdfService.generateQuotePdf(pdfData);
        const warnings: string[] = [];
        const publicUrl = this.getQuotePublicUrl(signatureToken);

        const { error: updateError } = await supabase
            .from('quotes')
            .update({
                status: QuoteStatus.SENT,
                sent_at: new Date().toISOString(),
                signature_token: signatureToken,
                signature_token_expires_at: tokenExpiresAt,
                signature_provider: QuoteSignatureProvider.INTERNAL,
                yousign_signature_request_id: null,
                yousign_document_id: null,
                yousign_signer_id: null,
                yousign_status: null,
                yousign_signature_link_expires_at: null,
                yousign_last_event_name: null,
                yousign_last_event_at: null,
                terms_and_conditions: resolvedTerms,
                legal_document_version_id: legalVersion?.version.id || null,
                legal_document_version_number: legalVersion?.version.version_number || null,
                terms_checksum_sha256: legalVersion?.checksum_sha256 || null,
            })
            .eq('id', quoteId);

        if (updateError) {
            console.error('Error sending quote:', updateError);
            throw new BadRequestException("Erreur lors de l'envoi du devis");
        }

        quote.signature_provider = QuoteSignatureProvider.INTERNAL;

        // Envoyer l'email
        if (this.notificationService.isEmailConfigured()) {
            try {
                const result = await this.notificationService.sendQuoteEmailV2(
                    quote,
                    quote.client,
                    quote.company,
                    pdfBuffer,
                );
                if (!result.success) {
                    console.error('Error sending quote email:', result.error);
                    warnings.push("L'email n'a pas pu être envoyé.");
                }
            } catch (emailError) {
                console.error('Error sending quote email:', emailError);
                warnings.push("L'email n'a pas pu être envoyé.");
            }
        }

        const sentQuote = await this.findOne(userId, companyId, quoteId);

        // Notifier via WebSocket
        this.websocketGateway.notifyQuoteStatusChanged(companyId, sentQuote);

        return {
            quote: sentQuote,
            public_url: publicUrl,
            warnings,
        };
    }

    /**
     * Signe un devis (accès public via token)
     */
    async sign(token: string, dto: SignQuoteDto, ip: string, userAgent: string): Promise<{ quote: PublicQuote; invoice_id: string }> {
        const supabase = getSupabaseAdmin();

        // Récupérer le devis
        const { data: quote, error: fetchError } = await supabase
            .from('quotes')
            .select('*')
            .eq('signature_token', token)
            .single();

        if (fetchError || !quote) {
            throw new NotFoundException('Devis non trouvé ou lien expiré');
        }

        if (quote.signature_provider === QuoteSignatureProvider.YOUSIGN) {
            throw new BadRequestException(
                "Ce devis ne peut plus être signé via ce lien public. Contactez l'entreprise émettrice.",
            );
        }

        // Vérifications
        if (this.isSignatureTokenExpired(quote)) {
            throw new ForbiddenException('Le lien de signature a expiré');
        }

        if (!['sent', 'viewed'].includes(quote.status)) {
            throw new ForbiddenException('Ce devis ne peut plus être signé');
        }

        if (quote.terms_and_conditions && !dto.cgv_accepted) {
            throw new BadRequestException('Vous devez accepter les conditions générales de vente pour signer');
        }

        if (!dto.consent_accepted) {
            throw new BadRequestException('Vous devez accepter les conditions pour signer');
        }

        const legalVersion = quote.terms_and_conditions
            ? await this.legalDocumentService.resolveQuoteTermsVersion(
                quote.company_id,
                quote.terms_and_conditions,
                quote.created_by,
                quote.id,
            )
            : null;

        const documentHash = this.buildQuoteDocumentHash({
            ...quote,
            terms_and_conditions: legalVersion?.content_text || quote.terms_and_conditions,
            terms_checksum_sha256: legalVersion?.checksum_sha256 || quote.terms_checksum_sha256,
        });

        const consentText = dto.cgv_accepted
            ? 'Je reconnais avoir pris connaissance de ce devis, de ses conditions générales de vente, et l\'accepte dans son intégralité.'
            : 'Je reconnais avoir pris connaissance de ce devis et l\'accepte dans son intégralité.';

        // Mettre à jour le devis comme signé
        const { error: updateError } = await supabase
            .from('quotes')
            .update({
                status: QuoteStatus.SIGNED,
                signed_at: new Date().toISOString(),
                signature_checkbox: true,
                signer_name: dto.signer_name,
                signer_ip: ip,
                legal_document_version_id: legalVersion?.version.id || quote.legal_document_version_id || null,
                legal_document_version_number: legalVersion?.version.version_number || quote.legal_document_version_number || null,
                terms_checksum_sha256: legalVersion?.checksum_sha256 || quote.terms_checksum_sha256 || null,
            })
            .eq('id', quote.id);

        if (updateError) {
            console.error('Error signing quote:', updateError);
            throw new BadRequestException('Erreur lors de la signature du devis');
        }

        // Créer la signature dans quote_signatures
        const { error: sigError } = await supabase
            .from('quote_signatures')
            .insert({
                quote_id: quote.id,
                signer_name: dto.signer_name,
                signer_email: dto.signer_email,
                ip_address: ip,
                user_agent: userAgent,
                document_hash: documentHash,
                consent_text: consentText,
                consent_accepted: true,
                accepted_legal_version_id: legalVersion?.version.id || quote.legal_document_version_id || null,
                accepted_terms_snapshot: legalVersion?.content_text || quote.terms_and_conditions || null,
                accepted_terms_checksum: legalVersion?.checksum_sha256 || quote.terms_checksum_sha256 || null,
            });

        if (sigError) {
            console.error('Error creating signature:', sigError);
        }

        // Convertir en facture
        const { data: invoiceId, error: convertError } = await supabase.rpc('convert_quote_to_invoice', {
            p_quote_id: quote.id,
            p_user_id: quote.created_by,
        });

        if (convertError) {
            console.error('Error converting quote to invoice:', convertError);
            throw new BadRequestException('Erreur lors de la conversion en facture');
        }

        // Récupérer le devis mis à jour
        const updatedQuote = await this.getPublicQuoteByToken(token);

        // Notifier via WebSocket que le devis a été signé
        this.websocketGateway.notifyQuoteSigned(quote.company_id, updatedQuote);

        return {
            quote: updatedQuote,
            invoice_id: invoiceId,
        };
    }

    /**
     * Refuse un devis (accès public via token)
     */
    async refuse(token: string, dto: RefuseQuoteDto): Promise<PublicQuote> {
        const supabase = getSupabaseAdmin();

        // Récupérer le devis
        const { data: quote, error: fetchError } = await supabase
            .from('quotes')
            .select('*')
            .eq('signature_token', token)
            .single();

        if (fetchError || !quote) {
            throw new NotFoundException('Devis non trouvé ou lien expiré');
        }

        if (this.isSignatureTokenExpired(quote)) {
            throw new ForbiddenException('Le lien de signature a expiré');
        }

        if (!['sent', 'viewed'].includes(quote.status)) {
            throw new ForbiddenException('Ce devis ne peut plus être refusé');
        }

        // Mettre à jour le devis comme refusé
        const { error: updateError } = await supabase
            .from('quotes')
            .update({
                status: QuoteStatus.REFUSED,
                refused_at: new Date().toISOString(),
                refusal_reason: dto.reason || null,
                yousign_status: quote.yousign_status || null,
            })
            .eq('id', quote.id);

        if (updateError) {
            console.error('Error refusing quote:', updateError);
            throw new BadRequestException('Erreur lors du refus du devis');
        }

        // Récupérer le devis mis à jour
        const updatedQuote = await this.getPublicQuoteByToken(token);

        // Notifier via WebSocket que le devis a été refusé
        this.websocketGateway.notifyQuoteStatusChanged(quote.company_id, updatedQuote);

        return updatedQuote;
    }

    /**
     * Convertit manuellement un devis en facture
     */
    async convert(userId: string, companyId: string, quoteId: string): Promise<string> {
        await this.checkWriteAccess(userId, companyId);

        const supabase = getSupabaseAdmin();

        // Vérifier que le devis existe et peut être converti
        const { data: quote, error: fetchError } = await supabase
            .from('quotes')
            .select('status, converted_to_invoice_id')
            .eq('id', quoteId)
            .eq('company_id', companyId)
            .single();

        if (fetchError || !quote) {
            throw new NotFoundException('Devis non trouvé');
        }

        if (quote.converted_to_invoice_id) {
            throw new ConflictException('Ce devis a déjà été converti en facture');
        }

        if (!['sent', 'viewed', 'accepted', 'signed'].includes(quote.status)) {
            throw new ConflictException('Ce devis ne peut pas être converti en facture');
        }

        // Convertir en facture
        const { data: invoiceId, error: convertError } = await supabase.rpc('convert_quote_to_invoice', {
            p_quote_id: quoteId,
            p_user_id: userId,
        });

        if (convertError) {
            console.error('Error converting quote:', convertError);
            throw new BadRequestException('Erreur lors de la conversion en facture');
        }

        return invoiceId;
    }

    /**
     * Formate un devis pour la génération PDF
     */
    formatForPdf(quote: any): any {
        return {
            quote_number: quote.quote_number,
            issue_date: quote.issue_date,
            validity_date: quote.validity_date,
            subtotal: quote.subtotal,
            total_vat: quote.total_vat,
            total: quote.total,
            discount_type: quote.discount_type,
            discount_value: quote.discount_value,
            company: {
                name: quote.company?.name || '',
                legal_name: quote.company?.legal_name,
                siren: quote.company?.siren || '',
                vat_number: quote.company?.vat_number,
                address: quote.company?.address || '',
                postal_code: quote.company?.postal_code || '',
                city: quote.company?.city || '',
                country: quote.company?.country || 'FR',
                phone: quote.company?.phone,
                email: quote.company?.email,
                logo_url: quote.company?.logo_url,
                is_vat_exempt: Boolean(quote.company?.is_vat_exempt),
                vat_exemption_note: quote.company?.vat_exemption_note,
            },
            client: {
                company_name: quote.client?.company_name,
                first_name: quote.client?.first_name,
                last_name: quote.client?.last_name,
                siret: quote.client?.siret,
                vat_number: quote.client?.vat_number,
                address: quote.client?.address || '',
                postal_code: quote.client?.postal_code || '',
                city: quote.client?.city || '',
                country: quote.client?.country || 'FR',
                email: quote.client?.email,
            },
            items: (quote.items || []).map((item: any) => ({
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
            notes: quote.notes,
            title: quote.title,
            conditions: quote.terms_and_conditions,
        };
    }
}
