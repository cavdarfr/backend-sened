import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import * as archiver from "archiver";
import { Response } from "express";
import { getSupabaseAdmin } from "../../config/supabase.config";
import { normalizeBusinessIdentifiers } from "../../shared/utils/business-identifiers.util";
import {
  CreateCompanyDto,
  UpdateCompanyDto,
  CompanyWithRoleResponseDto,
  CompanyListResponseDto,
  CompanyQueryDto,
  InviteNewMerchantAdminDto,
  InviteAccountantFirmDto,
  AccountantDocumentsQueryDto,
  BulkDownloadLinkedClientDocumentsDto,
  AccountantDocumentPeriodDto,
  AccountantDocumentStatusDto,
  AccountantDocumentTypeDto,
} from "./dto/company.dto";
import { WebsocketGateway } from "../websocket/websocket.gateway";
import { NotificationService } from "../reminder/notification.service";
import { SubscriptionService } from "../subscription/subscription.service";
import {
  CompanyRole,
  CompanyOwnerRole,
  getUserCompanyRole,
  getUserCompanyAccessContext,
  canInviteSuperadminRole,
  canManageCompanyAsAdmin,
  canManageMembers,
  getInvitableRolesForCompanyType,
  ACCOUNTANT_ROLES,
} from "../../common/roles/roles";

interface CompanyEntity {
  id: string;
  owner_id: string;
  name: string;
  legal_name: string | null;
  siren: string | null;
  vat_number: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_url: string | null;
  rib_iban: string | null;
  rib_bic: string | null;
  rib_bank_name: string | null;
  is_vat_exempt: boolean;
  vat_exemption_note: string | null;
  default_vat_rate: number;
  default_payment_terms: number;
  terms_and_conditions: string | null;
  quote_validity_days: number;
  quote_footer: string | null;
  invoice_footer: string | null;
  accountant_company_id: string | null;
  created_at: string;
  updated_at: string;
}

interface UserCompanyRelation {
  id: string;
  user_id: string;
  company_id: string;
  role: CompanyRole;
  is_default: boolean;
  created_at: string;
  company?: CompanyEntity;
}

type OwnerCompanyRole = "merchant_admin" | "accountant";
type InvitationType = "member" | "accountant_firm" | "merchant_signup";

type AccountantDocumentType = AccountantDocumentTypeDto;
type AccountantDocumentPeriod = AccountantDocumentPeriodDto;
type AccountantDocumentStatus = AccountantDocumentStatusDto;

interface MerchantSignupDraft {
  company_name: string;
  siren: string;
  siret?: string | null;
  address?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface MerchantSignupInvitationSummary {
  id: string;
  email: string;
  role: CompanyRole;
  created_at: string;
  expires_at: string;
  company_name: string | null;
  siren: string | null;
  city: string | null;
}

interface AccountantStoredDocumentRecord {
  id: string;
  related_id: string | null;
  filename: string;
  storage_path: string;
  mime_type: string;
  created_at: string;
}

interface AccountantInvoiceListItem {
  id: string;
  invoice_number: string;
  total: number | string;
  status: string;
  issue_date: string | null;
  created_at: string;
  type: string | null;
}

interface AccountantDocumentListItem extends AccountantInvoiceListItem {
  document_kind: "invoice" | "credit_note";
  is_immutable: boolean;
  storage_available: boolean;
  stored_document_id: string | null;
  downloadable_filename: string | null;
}

interface AccountantDocumentsResponse {
  data: AccountantDocumentListItem[];
  total: number;
  downloadable_total: number;
  page: number;
  limit: number;
  total_pages: number;
}

type AccountantLinkRequestStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "cancelled";

interface AccountantLinkRequestEntity {
  id: string;
  accountant_company_id: string;
  merchant_company_id: string;
  request_origin: "existing_merchant" | "new_client_invitation";
  requested_by: string;
  status: AccountantLinkRequestStatus;
  created_at: string;
  responded_at: string | null;
  responded_by: string | null;
}

interface AccountantLinkRequestCompanySummary {
  id: string;
  name: string;
  legal_name: string | null;
  siren: string | null;
  email: string | null;
  city: string | null;
  logo_url: string | null;
}

/**
 * Service de gestion des entreprises
 * Implémente les opérations CRUD avec gestion des droits d'accès
 */
@Injectable()
export class CompanyService {
  private readonly documentsBucket =
    process.env.STORAGE_DOCUMENTS_BUCKET || "documents";

  constructor(
    private readonly websocketGateway: WebsocketGateway,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => SubscriptionService))
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Crée une nouvelle entreprise pour l'utilisateur
   * L'utilisateur devient automatiquement admin de cette entreprise
   */
  async create(
    userId: string,
    createCompanyDto: CreateCompanyDto,
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();
    const sourceAccountantCompanyId =
      createCompanyDto.source_accountant_company_id || null;
    const ownerRole: OwnerCompanyRole = sourceAccountantCompanyId
      ? "merchant_admin"
      : createCompanyDto.owner_role || "merchant_admin";

    if (sourceAccountantCompanyId) {
      const { data: sourceCompanyAccess, error: sourceCompanyError } =
        await supabase
          .from("user_companies")
          .select("role, company:companies(owner_id)")
          .eq("user_id", userId)
          .eq("company_id", sourceAccountantCompanyId)
          .maybeSingle();

      if (
        sourceCompanyError ||
        !sourceCompanyAccess ||
        sourceCompanyAccess.role !== "accountant" ||
        sourceCompanyAccess.company?.owner_id !== userId
      ) {
        throw new ForbiddenException(
          "Seul le propriétaire expert-comptable du cabinet peut créer une entreprise marchande liée.",
        );
      }
    }

    // Vérifie le quota d'entreprises de l'utilisateur
    await this.checkCompanyQuota(userId, ownerRole);

    // Normaliser les identifiants métier
    const normalized = normalizeBusinessIdentifiers({
      siren: createCompanyDto.siren,
      vat_number: createCompanyDto.vat_number,
      country: createCompanyDto.country,
    });

    // Vérifie si le SIREN existe déjà
    if (normalized.siren) {
      const { data: existingSiren } = await supabase
        .from("companies")
        .select("id")
        .eq("siren", normalized.siren)
        .single();

      if (existingSiren) {
        throw new ConflictException("Une entreprise avec ce SIREN existe déjà");
      }
    }

    // Crée l'entreprise
    const { data: company, error: companyError } = await supabase
      .from("companies")
      .insert({
        ...this.getCompanyInsertPayload(createCompanyDto),
        owner_id: userId,
        accountant_company_id: sourceAccountantCompanyId,
        siren: normalized.siren,
        vat_number: normalized.vat_number,
        country: normalized.country,
        default_vat_rate: createCompanyDto.is_vat_exempt
          ? 0
          : createCompanyDto.default_vat_rate ?? 20.0,
        default_payment_terms: createCompanyDto.default_payment_terms ?? 30,
        quote_validity_days: createCompanyDto.quote_validity_days ?? 30,
      })
      .select()
      .single();

    if (companyError) {
      throw new BadRequestException(
        `Erreur lors de la création: ${companyError.message}`,
      );
    }

    const { data: existingDefaultRelations } = await supabase
      .from("user_companies")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true);

    const defaultRelationIds = (existingDefaultRelations || []).map(
      (relation: { id: string }) => relation.id,
    );

    if (defaultRelationIds.length > 0) {
      const { error: unsetDefaultError } = await supabase
        .from("user_companies")
        .update({ is_default: false })
        .eq("user_id", userId)
        .eq("is_default", true);

      if (unsetDefaultError) {
        await supabase.from("companies").delete().eq("id", company.id);
        throw new BadRequestException(
          `Erreur lors de la mise à jour de l'entreprise par défaut: ${unsetDefaultError.message}`,
        );
      }
    }

    const { error: relationError } = await supabase
      .from("user_companies")
      .insert({
        user_id: userId,
        company_id: company.id,
        role: ownerRole,
        is_default: true,
      });

    if (relationError) {
      // Rollback: supprime l'entreprise si la relation échoue
      if (defaultRelationIds.length > 0) {
        await supabase
          .from("user_companies")
          .update({ is_default: true })
          .in("id", defaultRelationIds);
      }
      await supabase.from("companies").delete().eq("id", company.id);
      throw new BadRequestException(
        `Erreur lors de la liaison: ${relationError.message}`,
      );
    }

    // Crée les unités par défaut pour l'entreprise
    await this.createDefaultUnits(company.id);

    const createdCompany = {
      ...this.mapCompanyWithRole(
        company as CompanyEntity,
        ownerRole,
        true,
        userId,
        ownerRole,
      ),
    };

    // Notifier via WebSocket
    this.websocketGateway.notifyCompanyCreated(userId, createdCompany);

    return createdCompany;
  }

  /**
   * Récupère toutes les entreprises de l'utilisateur
   */
  async findAll(
    userId: string,
    query: CompanyQueryDto,
  ): Promise<CompanyListResponseDto> {
    const supabase = getSupabaseAdmin();
    const { search, page = 1, limit = 10 } = query;
    const offset = (page - 1) * limit;

    // Requête de base pour les entreprises de l'utilisateur
    const queryBuilder = supabase
      .from("user_companies")
      .select(
        `
                role,
                is_default,
                company:companies(*)
            `,
        { count: "exact" },
      )
      .eq("user_id", userId);

    // Récupère d'abord toutes les entreprises liées
    const {
      data: relations,
      error,
      count,
    } = await queryBuilder
      .range(offset, offset + limit - 1)
      .order("is_default", { ascending: false });

    const ownedTotal = await this.getOwnedCompaniesCount(userId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la récupération: ${error.message}`,
      );
    }

    const companyRelations = (relations || []).filter(
      (rel: any) => rel.company,
    );
    const ownerRoleMap = await this.getCompanyOwnerRoleMap(
      companyRelations.map((relation: any) => relation.company.id),
    );

    // Filtre par recherche si nécessaire (côté application car Supabase ne supporte pas le filtrage sur les relations)
    let companies = companyRelations.map((rel: any) =>
      this.mapCompanyWithRole(
        rel.company,
        rel.role,
        rel.is_default,
        userId,
        ownerRoleMap.get(rel.company.id) || "merchant_admin",
      ),
    );

    if (search) {
      const searchLower = search.toLowerCase();
      companies = companies.filter(
        (c: CompanyWithRoleResponseDto) =>
          c.name.toLowerCase().includes(searchLower) ||
          c.legal_name?.toLowerCase().includes(searchLower) ||
          c.siren?.includes(search) ||
          c.email?.toLowerCase().includes(searchLower),
      );
    }

    return {
      companies,
      total: count || companies.length,
      owned_total: ownedTotal,
    };
  }

  /**
   * Récupère une entreprise par son ID
   * Vérifie que l'utilisateur a accès à cette entreprise
   */
  async findOne(
    userId: string,
    companyId: string,
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    // Vérifie l'accès et récupère les données
    const { data: relation, error } = await supabase
      .from("user_companies")
      .select(
        `
                role,
                is_default,
                company:companies(*)
            `,
      )
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .single();

    if (error || !relation) {
      throw new NotFoundException("Entreprise non trouvée ou accès refusé");
    }

    const company = (relation as any).company;
    if (!company) {
      throw new NotFoundException("Entreprise non trouvée");
    }

    const mapped = this.mapCompanyWithRole(
      company,
      relation.role,
      relation.is_default,
      userId,
      await this.getCompanyOwnerRole(company.id),
    );
    return this.enrichWithAccountantInfo(mapped);
  }

  /**
   * Met à jour une entreprise
   * Seuls les admins peuvent modifier une entreprise
   */
  async update(
    userId: string,
    companyId: string,
    updateCompanyDto: UpdateCompanyDto,
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    const accessContext = await this.checkUserAccessContext(userId, companyId);

    if (
      !canManageCompanyAsAdmin(
        accessContext.role,
        accessContext.companyOwnerRole,
      )
    ) {
      throw new ForbiddenException(
        "Seuls les administrateurs peuvent modifier l'entreprise",
      );
    }

    if (updateCompanyDto.siren) {
      const { data: existingSiren } = await supabase
        .from("companies")
        .select("id")
        .eq("siren", updateCompanyDto.siren)
        .neq("id", companyId)
        .single();

      if (existingSiren) {
        throw new ConflictException(
          "Une autre entreprise avec ce SIREN existe déjà",
        );
      }
    }

    // Met à jour l'entreprise
    const { data: company, error } = await supabase
      .from("companies")
      .update(updateCompanyDto)
      .eq("id", companyId)
      .select()
      .single();

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la mise à jour: ${error.message}`,
      );
    }

    // Récupère les informations de relation
    const { data: relation } = await supabase
      .from("user_companies")
      .select("role, is_default")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .single();

    const updatedCompany = this.mapCompanyWithRole(
      company as CompanyEntity,
      (relation?.role || "merchant_admin") as CompanyRole,
      relation?.is_default || false,
      userId,
      await this.getCompanyOwnerRole(companyId),
    );

    // Notifier via WebSocket
    this.websocketGateway.notifyCompanyUpdated(companyId, updatedCompany);

    return updatedCompany;
  }

  /**
   * Supprime une entreprise
   * Seuls les admins peuvent supprimer une entreprise
   */
  async remove(
    userId: string,
    companyId: string,
  ): Promise<{ message: string }> {
    const supabase = getSupabaseAdmin();

    const accessContext = await this.checkUserAccessContext(userId, companyId);

    if (
      !canManageCompanyAsAdmin(
        accessContext.role,
        accessContext.companyOwnerRole,
      )
    ) {
      throw new ForbiddenException(
        "Seuls les administrateurs peuvent supprimer l'entreprise",
      );
    }

    const { data: userCompanies } = await supabase
      .from("user_companies")
      .select("id")
      .eq("user_id", userId);

    if (userCompanies && userCompanies.length <= 1) {
      throw new BadRequestException("Vous devez avoir au moins une entreprise");
    }

    // Vérifie si l'entreprise a des devis ou factures
    const { data: quotes } = await supabase
      .from("quotes")
      .select("id")
      .eq("company_id", companyId)
      .limit(1);

    const { data: invoices } = await supabase
      .from("invoices")
      .select("id")
      .eq("company_id", companyId)
      .limit(1);

    if ((quotes && quotes.length > 0) || (invoices && invoices.length > 0)) {
      throw new BadRequestException(
        "Cette entreprise contient des devis ou factures. Veuillez les supprimer ou les transférer avant de supprimer l'entreprise.",
      );
    }

    // Supprime l'entreprise (les relations sont supprimées en cascade)
    const { error } = await supabase
      .from("companies")
      .delete()
      .eq("id", companyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la suppression: ${error.message}`,
      );
    }

    // Notifier via WebSocket
    this.websocketGateway.notifyCompanyDeleted(userId, companyId);

    // Si c'était l'entreprise par défaut, définit une autre comme défaut
    await this.ensureDefaultCompany(userId);

    return { message: "Entreprise supprimée avec succès" };
  }

  /**
   * Définit une entreprise comme entreprise par défaut
   */
  async setDefault(
    userId: string,
    companyId: string,
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    // Vérifie l'accès à l'entreprise
    await this.checkUserAccess(userId, companyId);

    // Retire le flag par défaut de toutes les entreprises de l'utilisateur
    await supabase
      .from("user_companies")
      .update({ is_default: false })
      .eq("user_id", userId);

    // Définit la nouvelle entreprise par défaut
    const { error } = await supabase
      .from("user_companies")
      .update({ is_default: true })
      .eq("user_id", userId)
      .eq("company_id", companyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la définition par défaut: ${error.message}`,
      );
    }

    return this.findOne(userId, companyId);
  }

  /**
   * Récupère l'entreprise par défaut de l'utilisateur
   */
  async getDefault(userId: string): Promise<CompanyWithRoleResponseDto | null> {
    const supabase = getSupabaseAdmin();

    const { data: relation, error } = await supabase
      .from("user_companies")
      .select(
        `
                role,
                is_default,
                company:companies(*)
            `,
      )
      .eq("user_id", userId)
      .eq("is_default", true)
      .single();

    if (error || !relation) {
      // Retourne la première entreprise si aucune par défaut
      const { data: firstRelation } = await supabase
        .from("user_companies")
        .select(
          `
                    role,
                    is_default,
                    company:companies(*)
                `,
        )
        .eq("user_id", userId)
        .limit(1)
        .single();

      if (!firstRelation) {
        return null;
      }

      const company = (firstRelation as any).company;
      const companyOwnerRole = company
        ? await this.getCompanyOwnerRole(company.id)
        : "merchant_admin";
      return company
        ? this.mapCompanyWithRole(
            company,
            firstRelation.role,
            firstRelation.is_default,
            userId,
            companyOwnerRole,
          )
        : null;
    }

    const company = (relation as any).company;
    const companyOwnerRole = company
      ? await this.getCompanyOwnerRole(company.id)
      : "merchant_admin";
    return company
      ? this.mapCompanyWithRole(
          company,
          relation.role,
          relation.is_default,
          userId,
          companyOwnerRole,
        )
      : null;
  }

  // ============================================
  // Méthodes de mise à jour par section
  // ============================================

  /**
   * Met à jour les informations générales d'une entreprise
   * Section: Général (name, legal_name, siren, vat_number)
   */
  async updateGeneral(
    userId: string,
    companyId: string,
    data: {
      name?: string;
      legal_name?: string;
      siren?: string;
      vat_number?: string;
      logo_url?: string;
    },
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    // Vérifie les droits d'accès
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    if (
      !canManageCompanyAsAdmin(
        accessContext.role,
        accessContext.companyOwnerRole,
      )
    ) {
      throw new ForbiddenException(
        "Seuls les administrateurs peuvent modifier l'entreprise",
      );
    }

    // Normaliser les identifiants si présents
    const normalized =
      data.siren !== undefined || data.vat_number !== undefined
        ? normalizeBusinessIdentifiers({
            siren: data.siren,
            vat_number: data.vat_number,
          })
        : null;

    // Vérifie si le nouveau SIREN existe déjà (si modifié)
    const cleanedSiren =
      normalized?.siren ?? (data.siren === undefined ? undefined : null);
    if (cleanedSiren) {
      const { data: existingSiren } = await supabase
        .from("companies")
        .select("id")
        .eq("siren", cleanedSiren)
        .neq("id", companyId)
        .single();

      if (existingSiren) {
        throw new ConflictException(
          "Une autre entreprise avec ce SIREN existe déjà",
        );
      }
    }

    // Met à jour uniquement les champs de la section générale
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.legal_name !== undefined)
      updateData.legal_name = data.legal_name || null;
    if (data.siren !== undefined) updateData.siren = normalized?.siren ?? null;
    if (data.vat_number !== undefined)
      updateData.vat_number = normalized?.vat_number ?? null;
    if (data.logo_url !== undefined)
      updateData.logo_url = data.logo_url || null;

    const { error } = await supabase
      .from("companies")
      .update(updateData)
      .eq("id", companyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la mise à jour: ${error.message}`,
      );
    }

    return this.findOne(userId, companyId);
  }

  /**
   * Met à jour les coordonnées d'une entreprise
   * Section: Contact (email, phone, website, address, city, postal_code, country)
   */
  async updateContact(
    userId: string,
    companyId: string,
    data: {
      email?: string;
      phone?: string;
      website?: string;
      address?: string;
      city?: string;
      postal_code?: string;
      country?: string;
    },
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    // Vérifie les droits d'accès
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    if (
      !canManageCompanyAsAdmin(
        accessContext.role,
        accessContext.companyOwnerRole,
      )
    ) {
      throw new ForbiddenException(
        "Seuls les administrateurs peuvent modifier l'entreprise",
      );
    }

    // Met à jour uniquement les champs de la section contact
    const updateData: any = {};
    if (data.email !== undefined) updateData.email = data.email || null;
    if (data.phone !== undefined) updateData.phone = data.phone || null;
    if (data.website !== undefined) updateData.website = data.website || null;
    if (data.address !== undefined) updateData.address = data.address || null;
    if (data.city !== undefined) updateData.city = data.city || null;
    if (data.postal_code !== undefined)
      updateData.postal_code = data.postal_code || null;
    if (data.country !== undefined) {
      const { country } = normalizeBusinessIdentifiers({
        country: data.country,
      });
      updateData.country = country;
    }

    const { error } = await supabase
      .from("companies")
      .update(updateData)
      .eq("id", companyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la mise à jour: ${error.message}`,
      );
    }

    return this.findOne(userId, companyId);
  }

  /**
   * Met à jour les informations bancaires d'une entreprise
   * Section: Bancaire (rib_iban, rib_bic, rib_bank_name)
   */
  async updateBanking(
    userId: string,
    companyId: string,
    data: { rib_iban?: string; rib_bic?: string; rib_bank_name?: string },
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    // Vérifie les droits d'accès
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    if (
      !canManageCompanyAsAdmin(
        accessContext.role,
        accessContext.companyOwnerRole,
      )
    ) {
      throw new ForbiddenException(
        "Seuls les administrateurs peuvent modifier l'entreprise",
      );
    }

    // Met à jour uniquement les champs de la section bancaire
    const updateData: any = {};
    if (data.rib_iban !== undefined)
      updateData.rib_iban = data.rib_iban || null;
    if (data.rib_bic !== undefined) updateData.rib_bic = data.rib_bic || null;
    if (data.rib_bank_name !== undefined)
      updateData.rib_bank_name = data.rib_bank_name || null;

    const { error } = await supabase
      .from("companies")
      .update(updateData)
      .eq("id", companyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la mise à jour: ${error.message}`,
      );
    }

    return this.findOne(userId, companyId);
  }

  /**
   * Met à jour les paramètres d'une entreprise
   * Section: Paramètres (default_vat_rate, default_payment_terms, quote_validity_days, terms_and_conditions, quote_footer, invoice_footer)
   */
  async updateSettings(
    userId: string,
    companyId: string,
    data: {
      default_vat_rate?: number;
      is_vat_exempt?: boolean;
      vat_exemption_note?: string;
      default_payment_terms?: number;
      quote_validity_days?: number;
      terms_and_conditions?: string;
      quote_footer?: string;
      invoice_footer?: string;
    },
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    // Vérifie les droits d'accès
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    if (
      !canManageCompanyAsAdmin(
        accessContext.role,
        accessContext.companyOwnerRole,
      )
    ) {
      throw new ForbiddenException(
        "Seuls les administrateurs peuvent modifier l'entreprise",
      );
    }

    // Met à jour uniquement les champs de la section paramètres
    const updateData: any = {};
    if (data.default_vat_rate !== undefined)
      updateData.default_vat_rate = data.default_vat_rate;
    if (data.is_vat_exempt !== undefined) {
      updateData.is_vat_exempt = data.is_vat_exempt;
      if (data.is_vat_exempt) {
        updateData.default_vat_rate = 0;
      }
    }
    if (data.vat_exemption_note !== undefined)
      updateData.vat_exemption_note =
        data.vat_exemption_note?.trim() ||
        "TVA non applicable, art. 293 B du CGI";
    if (data.default_payment_terms !== undefined)
      updateData.default_payment_terms = data.default_payment_terms;
    if (data.quote_validity_days !== undefined)
      updateData.quote_validity_days = data.quote_validity_days;
    if (data.terms_and_conditions !== undefined)
      updateData.terms_and_conditions = data.terms_and_conditions || null;
    if (data.quote_footer !== undefined)
      updateData.quote_footer = data.quote_footer || null;
    if (data.invoice_footer !== undefined)
      updateData.invoice_footer = data.invoice_footer || null;

    const { error } = await supabase
      .from("companies")
      .update(updateData)
      .eq("id", companyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la mise à jour: ${error.message}`,
      );
    }

    return this.findOne(userId, companyId);
  }

  // ============================================
  // Méthodes privées utilitaires
  // ============================================

  private async checkUserAccess(
    userId: string,
    companyId: string,
  ): Promise<CompanyRole> {
    return getUserCompanyRole(userId, companyId);
  }

  private async checkUserAccessContext(userId: string, companyId: string) {
    return getUserCompanyAccessContext(userId, companyId);
  }

  private async getCompanyOwnerRoleMap(
    companyIds: string[],
  ): Promise<Map<string, CompanyOwnerRole>> {
    if (companyIds.length === 0) {
      return new Map();
    }

    const supabase = getSupabaseAdmin();
    const uniqueCompanyIds = Array.from(new Set(companyIds));

    const { data: companies, error: companiesError } = await supabase
      .from("companies")
      .select("id, owner_id")
      .in("id", uniqueCompanyIds);

    if (companiesError) {
      throw new BadRequestException(
        `Erreur lors du chargement du contexte société: ${companiesError.message}`,
      );
    }

    const ownerIds = Array.from(
      new Set(
        (companies || [])
          .map((company: any) => company.owner_id)
          .filter((ownerId: string | null): ownerId is string =>
            Boolean(ownerId),
          ),
      ),
    );

    const ownerRolesByCompanyId = new Map<string, CompanyOwnerRole>();
    if (ownerIds.length > 0) {
      const { data: ownerRelations, error: ownerRelationsError } =
        await supabase
          .from("user_companies")
          .select("company_id, user_id, role")
          .in("company_id", uniqueCompanyIds)
          .in("user_id", ownerIds);

      if (ownerRelationsError) {
        throw new BadRequestException(
          `Erreur lors du chargement du rôle propriétaire: ${ownerRelationsError.message}`,
        );
      }

      for (const relation of ownerRelations || []) {
        const company = (companies || []).find(
          (entry: any) => entry.id === relation.company_id,
        );
        if (!company || company.owner_id !== relation.user_id) {
          continue;
        }

        ownerRolesByCompanyId.set(
          relation.company_id,
          relation.role === "accountant" ? "accountant" : "merchant_admin",
        );
      }
    }

    for (const company of companies || []) {
      if (!ownerRolesByCompanyId.has(company.id)) {
        ownerRolesByCompanyId.set(company.id, "merchant_admin");
      }
    }

    return ownerRolesByCompanyId;
  }

  private async getCompanyOwnerRole(
    companyId: string,
  ): Promise<CompanyOwnerRole> {
    const ownerRoleMap = await this.getCompanyOwnerRoleMap([companyId]);
    return ownerRoleMap.get(companyId) || "merchant_admin";
  }

  private getCompanyInsertPayload(
    createCompanyDto: CreateCompanyDto,
  ): Omit<CreateCompanyDto, "owner_role" | "source_accountant_company_id"> {
    const { owner_role, source_accountant_company_id, ...companyData } =
      createCompanyDto;
    return companyData;
  }

  private mapCompanyWithRole(
    company: CompanyEntity,
    role: CompanyRole,
    isDefault: boolean,
    userId: string,
    companyOwnerRole: CompanyOwnerRole,
  ): CompanyWithRoleResponseDto {
    return {
      ...company,
      role,
      is_default: isDefault,
      is_owner: company.owner_id === userId,
      company_owner_role: companyOwnerRole,
      accountant_firm_summary: null,
      accountant_link_status: "none",
    };
  }

  private async enrichWithAccountantInfo(
    companyResponse: CompanyWithRoleResponseDto,
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();
    const accountantCompanyId = companyResponse.accountant_company_id;

    if (accountantCompanyId) {
      const { data: accCompany } = await supabase
        .from("companies")
        .select("id, name, legal_name, siren, email, phone, city")
        .eq("id", accountantCompanyId)
        .single();

      companyResponse.accountant_firm_summary = accCompany || null;
      companyResponse.accountant_link_status = "linked";
    } else {
      const { data: pendingInvite } = await supabase
        .from("company_invitations")
        .select("id")
        .eq("company_id", companyResponse.id)
        .eq("invitation_type", "accountant_firm")
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString())
        .limit(1)
        .maybeSingle();

      companyResponse.accountant_firm_summary = null;
      companyResponse.accountant_link_status = pendingInvite
        ? "invite_pending"
        : "none";
    }

    return companyResponse;
  }

  private async getOwnedCompaniesCount(
    userId: string,
    ownerRole?: OwnerCompanyRole,
    options?: { excludeMerchantCompaniesLinkedToAccountantCabinet?: boolean },
  ): Promise<number> {
    const supabase = getSupabaseAdmin();

    const query = supabase
      .from("user_companies")
      .select("company_id, company:companies(owner_id, accountant_company_id)")
      .eq("user_id", userId);

    if (ownerRole) {
      query.eq("role", ownerRole);
    }

    const { data, error } = await query;

    if (error) {
      throw new BadRequestException(
        `Erreur lors du calcul des entreprises possédées: ${error.message}`,
      );
    }

    return (data || []).filter((relation: any) => {
      if (relation.company?.owner_id !== userId) {
        return false;
      }
      if (
        options?.excludeMerchantCompaniesLinkedToAccountantCabinet &&
        relation.company?.accountant_company_id
      ) {
        return false;
      }
      return true;
    }).length;
  }

  private async assertLinkedClientForAccountant(
    companyId: string,
    clientId: string,
  ): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: clientCompany, error: clientError } = await supabase
      .from("companies")
      .select("id")
      .eq("id", clientId)
      .eq("accountant_company_id", companyId)
      .single();

    if (clientError || !clientCompany) {
      throw new NotFoundException(
        "Client non trouvé ou non lié à votre cabinet",
      );
    }
  }

  private async assertCanManageLinkedClientMerchantAdminInvitations(
    userId: string,
    accountantCompanyId: string,
    clientId: string,
  ): Promise<void> {
    const userRole = await this.checkUserAccess(userId, accountantCompanyId);
    if (userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut gérer les invitations admin marchand de ce dossier client",
      );
    }

    await this.assertLinkedClientForAccountant(accountantCompanyId, clientId);
  }

  private validateAccountantDocumentType(type: string): AccountantDocumentType {
    if (type === "invoices" || type === "credit-notes") {
      return type;
    }

    throw new BadRequestException("Type de document comptable invalide");
  }

  private validateAccountantDocumentStatuses(
    statuses?: string[],
  ): AccountantDocumentStatus[] | undefined {
    if (!statuses || statuses.length === 0) {
      return undefined;
    }

    const uniqueStatuses = Array.from(new Set(statuses));
    if (
      uniqueStatuses.every(
        (status) =>
          status === "sent" ||
          status === "paid" ||
          status === "overdue" ||
          status === "cancelled",
      )
    ) {
      return uniqueStatuses as AccountantDocumentStatus[];
    }

    throw new BadRequestException("Statut de document comptable invalide");
  }

  private resolveAccountantDateRange(
    year?: number,
    period?: string,
  ): {
    year: number;
    period: AccountantDocumentPeriod;
    from: string;
    to: string;
  } {
    const resolvedYear = year || new Date().getFullYear();

    if (
      !Number.isInteger(resolvedYear) ||
      resolvedYear < 2000 ||
      resolvedYear > 2100
    ) {
      throw new BadRequestException("Année invalide");
    }

    const resolvedPeriod = (period || "year") as AccountantDocumentPeriod;
    const periods: Record<
      AccountantDocumentPeriod,
      { from: string; to: string }
    > = {
      year: { from: `${resolvedYear}-01-01`, to: `${resolvedYear}-12-31` },
      q1: { from: `${resolvedYear}-01-01`, to: `${resolvedYear}-03-31` },
      q2: { from: `${resolvedYear}-04-01`, to: `${resolvedYear}-06-30` },
      q3: { from: `${resolvedYear}-07-01`, to: `${resolvedYear}-09-30` },
      q4: { from: `${resolvedYear}-10-01`, to: `${resolvedYear}-12-31` },
      m01: { from: `${resolvedYear}-01-01`, to: `${resolvedYear}-01-31` },
      m02: { from: `${resolvedYear}-02-01`, to: `${resolvedYear}-02-29` },
      m03: { from: `${resolvedYear}-03-01`, to: `${resolvedYear}-03-31` },
      m04: { from: `${resolvedYear}-04-01`, to: `${resolvedYear}-04-30` },
      m05: { from: `${resolvedYear}-05-01`, to: `${resolvedYear}-05-31` },
      m06: { from: `${resolvedYear}-06-01`, to: `${resolvedYear}-06-30` },
      m07: { from: `${resolvedYear}-07-01`, to: `${resolvedYear}-07-31` },
      m08: { from: `${resolvedYear}-08-01`, to: `${resolvedYear}-08-31` },
      m09: { from: `${resolvedYear}-09-01`, to: `${resolvedYear}-09-30` },
      m10: { from: `${resolvedYear}-10-01`, to: `${resolvedYear}-10-31` },
      m11: { from: `${resolvedYear}-11-01`, to: `${resolvedYear}-11-30` },
      m12: { from: `${resolvedYear}-12-01`, to: `${resolvedYear}-12-31` },
    };

    const resolvedRange = periods[resolvedPeriod];
    if (!resolvedRange) {
      throw new BadRequestException("Période comptable invalide");
    }

    return {
      year: resolvedYear,
      period: resolvedPeriod,
      ...resolvedRange,
    };
  }

  private buildAccountantDownloadFilename(
    document: AccountantInvoiceListItem,
  ): string {
    const prefix = document.type === "credit_note" ? "avoir" : "facture";
    return `${prefix}-${document.invoice_number}.pdf`;
  }

  private sanitizeDownloadFilename(value: string, fallback: string): string {
    const sanitized = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();

    return sanitized || fallback;
  }

  private buildUniqueArchiveFilename(
    filename: string,
    usedNames: Map<string, number>,
  ): string {
    const normalizedFilename = this.sanitizeDownloadFilename(
      filename,
      "document.pdf",
    );
    const extensionIndex = normalizedFilename.lastIndexOf(".");
    const hasExtension = extensionIndex > 0;
    const baseName = hasExtension
      ? normalizedFilename.slice(0, extensionIndex)
      : normalizedFilename;
    const extension = hasExtension
      ? normalizedFilename.slice(extensionIndex)
      : "";
    const currentCount = usedNames.get(normalizedFilename) || 0;

    if (currentCount === 0) {
      usedNames.set(normalizedFilename, 1);
      return normalizedFilename;
    }

    const nextCount = currentCount + 1;
    usedNames.set(normalizedFilename, nextCount);
    return `${baseName} (${nextCount})${extension}`;
  }

  private async loadAccountantDocuments(
    clientId: string,
    params: Pick<
      AccountantDocumentsQueryDto,
      "type" | "year" | "period" | "statuses"
    >,
  ): Promise<AccountantDocumentListItem[]> {
    const supabase = getSupabaseAdmin();
    const documentType = this.validateAccountantDocumentType(
      params.type || "invoices",
    );
    const documentStatuses = this.validateAccountantDocumentStatuses(
      params.statuses,
    );
    const { from, to } = this.resolveAccountantDateRange(
      params.year,
      params.period,
    );

    let query = supabase
      .from("invoices")
      .select("id, invoice_number, total, status, issue_date, created_at, type")
      .eq("company_id", clientId)
      .neq("status", "draft")
      .gte("issue_date", from)
      .lte("issue_date", to);

    if (documentType === "credit-notes") {
      query = query.eq("type", "credit_note");
    } else {
      query = query.neq("type", "credit_note");
    }

    if (documentStatuses && documentStatuses.length > 0) {
      query = query.in("status", documentStatuses);
    }

    const { data, error } = await query.order("issue_date", {
      ascending: false,
    });

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    const typedDocuments = (data || []) as AccountantInvoiceListItem[];
    const documentMap = await this.getStoredAccountantDocumentsMap(
      clientId,
      typedDocuments.map((invoice) => invoice.id),
    );

    return typedDocuments.map((invoice) => {
      const storedDocument = documentMap.get(invoice.id);
      return {
        ...invoice,
        document_kind:
          invoice.type === "credit_note" ? "credit_note" : "invoice",
        is_immutable: invoice.status !== "draft",
        storage_available: Boolean(storedDocument?.storage_path),
        stored_document_id: storedDocument?.id || null,
        downloadable_filename:
          storedDocument?.filename ||
          this.buildAccountantDownloadFilename(invoice),
      };
    });
  }

  private async getStoredAccountantDocumentsMap(
    clientId: string,
    invoiceIds: string[],
  ): Promise<Map<string, AccountantStoredDocumentRecord>> {
    const supabase = getSupabaseAdmin();

    if (invoiceIds.length === 0) {
      return new Map();
    }

    const { data: storedDocuments, error: storedError } = await supabase
      .from("documents")
      .select("id, related_id, filename, storage_path, mime_type, created_at")
      .eq("company_id", clientId)
      .eq("related_type", "invoice")
      .eq("type", "invoice_pdf")
      .in("related_id", invoiceIds)
      .order("created_at", { ascending: false });

    if (storedError) {
      throw new BadRequestException(`Erreur: ${storedError.message}`);
    }

    const documentsMap = new Map<string, AccountantStoredDocumentRecord>();
    ((storedDocuments || []) as AccountantStoredDocumentRecord[]).forEach(
      (storedDocument) => {
        if (
          !storedDocument.related_id ||
          documentsMap.has(storedDocument.related_id)
        ) {
          return;
        }

        if (!storedDocument.storage_path) {
          return;
        }

        documentsMap.set(
          storedDocument.related_id,
          storedDocument as AccountantStoredDocumentRecord,
        );
      },
    );

    return documentsMap;
  }

  /**
   * Vérifie le quota d'entreprises de l'utilisateur selon son abonnement
   */
  private async checkCompanyQuota(
    userId: string,
    ownerRole: OwnerCompanyRole,
  ): Promise<void> {
    // Billing is now company-centric: merchant owners can always create
    // a new company, then subscribe specifically for that company.
    if (ownerRole === "merchant_admin") {
      return;
    }

    // Accountant behavior remains unchanged.
    void userId;
  }

  /**
   * S'assure qu'une entreprise par défaut existe pour l'utilisateur
   */
  private async ensureDefaultCompany(userId: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Vérifie si une entreprise par défaut existe
    const { data: defaultCompany } = await supabase
      .from("user_companies")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .single();

    if (!defaultCompany) {
      // Définit la première entreprise comme défaut
      const { data: firstCompany } = await supabase
        .from("user_companies")
        .select("id")
        .eq("user_id", userId)
        .limit(1)
        .single();

      if (firstCompany) {
        await supabase
          .from("user_companies")
          .update({ is_default: true })
          .eq("id", firstCompany.id);
      }
    }
  }

  /**
   * Crée les unités par défaut pour une nouvelle entreprise
   */
  private async createDefaultUnits(companyId: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    const defaultUnits = [
      { company_id: companyId, name: "Heure", abbreviation: "h" },
      { company_id: companyId, name: "Jour", abbreviation: "j" },
      { company_id: companyId, name: "Unité", abbreviation: "u" },
      { company_id: companyId, name: "Forfait", abbreviation: "forf." },
      { company_id: companyId, name: "Mètre", abbreviation: "m" },
      { company_id: companyId, name: "Mètre carré", abbreviation: "m²" },
      { company_id: companyId, name: "Kilogramme", abbreviation: "kg" },
      { company_id: companyId, name: "Litre", abbreviation: "L" },
    ];

    await supabase.from("units").insert(defaultUnits);
  }

  private async createAccountantLinkRequestRecord(
    userId: string,
    accountantCompanyId: string,
    merchantCompanyId: string,
    requestOrigin: "existing_merchant" | "new_client_invitation",
  ): Promise<AccountantLinkRequestEntity> {
    const supabase = getSupabaseAdmin();

    const { data: request, error } = await supabase
      .from("accountant_link_requests")
      .insert({
        accountant_company_id: accountantCompanyId,
        merchant_company_id: merchantCompanyId,
        request_origin: requestOrigin,
        requested_by: userId,
        status: "pending",
      })
      .select(
        "id, accountant_company_id, merchant_company_id, request_origin, requested_by, status, created_at, responded_at, responded_by",
      )
      .single();

    if (error || !request) {
      throw new BadRequestException(
        `Erreur lors de la création de la demande de liaison: ${error?.message || "inconnue"}`,
      );
    }

    return request as AccountantLinkRequestEntity;
  }

  // ============================================
  // Accountant linking
  // ============================================

  async linkAccountant(
    userId: string,
    companyId: string,
    accountantCompanyId: string,
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    const userRole = await this.checkUserAccess(userId, companyId);
    if (userRole !== "merchant_admin") {
      throw new ForbiddenException(
        "Seul un administrateur commerçant peut lier un expert-comptable",
      );
    }

    if (companyId === accountantCompanyId) {
      throw new BadRequestException(
        "Une entreprise ne peut pas être son propre expert-comptable",
      );
    }

    const { data: accountantCompany, error: accError } = await supabase
      .from("companies")
      .select("id, name")
      .eq("id", accountantCompanyId)
      .single();

    if (accError || !accountantCompany) {
      throw new NotFoundException("Entreprise comptable non trouvée");
    }

    // Annuler les invitations de cabinet en attente
    await supabase
      .from("company_invitations")
      .delete()
      .eq("company_id", companyId)
      .eq("invitation_type", "accountant_firm")
      .is("accepted_at", null);

    const { error } = await supabase
      .from("companies")
      .update({ accountant_company_id: accountantCompanyId })
      .eq("id", companyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la liaison: ${error.message}`,
      );
    }

    await supabase
      .from("accountant_link_requests")
      .update({
        status: "cancelled",
        responded_at: new Date().toISOString(),
        responded_by: userId,
      })
      .eq("merchant_company_id", companyId)
      .eq("status", "pending");

    return this.findOne(userId, companyId);
  }

  async unlinkAccountant(
    userId: string,
    companyId: string,
  ): Promise<CompanyWithRoleResponseDto> {
    const supabase = getSupabaseAdmin();

    const userRole = await this.checkUserAccess(userId, companyId);
    if (userRole !== "merchant_admin") {
      throw new ForbiddenException(
        "Seul un administrateur commerçant peut délier un expert-comptable",
      );
    }

    const { error } = await supabase
      .from("companies")
      .update({ accountant_company_id: null })
      .eq("id", companyId);

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    return this.findOne(userId, companyId);
  }

  async inviteAccountantFirm(
    userId: string,
    companyId: string,
    dto: InviteAccountantFirmDto,
  ): Promise<
    | {
        status: "existing_accountant";
        accountant_company: { id: string; name: string; siren: string | null };
      }
    | { status: "invited"; invitation_id: string; email: string }
  > {
    const supabase = getSupabaseAdmin();

    const userRole = await this.checkUserAccess(userId, companyId);
    if (userRole !== "merchant_admin") {
      throw new ForbiddenException(
        "Seul un administrateur commerçant peut inviter un cabinet comptable",
      );
    }

    const normalizedEmail = dto.email.trim().toLowerCase();
    const normalizedSiren = dto.siren.replace(/\s/g, "");
    const firmName = dto.firm_name.trim();

    if (!firmName) {
      throw new BadRequestException("Le nom du cabinet est requis");
    }

    const existingMatch = await this.findExistingAccountantCompany(
      normalizedSiren,
      normalizedEmail,
    );
    if (existingMatch) {
      return {
        status: "existing_accountant",
        accountant_company: existingMatch,
      };
    }

    const { data: pendingInviteByEmail } = await supabase
      .from("company_invitations")
      .select("id")
      .eq("company_id", companyId)
      .eq("invitation_type", "accountant_firm")
      .ilike("email", normalizedEmail)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (pendingInviteByEmail) {
      throw new ConflictException(
        "Une invitation cabinet est déjà en attente pour cet email",
      );
    }

    const { data: pendingInviteBySiren } = await supabase
      .from("company_invitations")
      .select("id")
      .eq("company_id", companyId)
      .eq("invitation_type", "accountant_firm")
      .eq("invited_firm_siren", normalizedSiren)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (pendingInviteBySiren) {
      throw new ConflictException(
        "Une invitation cabinet est déjà en attente pour ce SIREN",
      );
    }

    const { data: invitation, error: invitationError } = await supabase
      .from("company_invitations")
      .insert({
        company_id: companyId,
        email: normalizedEmail,
        role: "accountant",
        invited_by: userId,
        invitation_type: "accountant_firm",
        invited_firm_name: firmName,
        invited_firm_siren: normalizedSiren,
      })
      .select("id, token, email")
      .single();

    if (invitationError || !invitation) {
      throw new BadRequestException(
        `Erreur lors de l'invitation du cabinet: ${invitationError?.message || "inconnue"}`,
      );
    }

    const { data: company } = await supabase
      .from("companies")
      .select("name, email, phone, address, postal_code, city, siren, logo_url")
      .eq("id", companyId)
      .single();

    const { data: inviter } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", userId)
      .single();

    const inviterName =
      [inviter?.first_name, inviter?.last_name].filter(Boolean).join(" ") ||
      "Un administrateur";

    try {
      await this.notificationService.sendInviteEmail(
        normalizedEmail,
        inviterName,
        company,
        "accountant",
        invitation.token,
      );
    } catch {
      // Ne pas échouer si l'envoi email échoue
    }

    return {
      status: "invited",
      invitation_id: invitation.id,
      email: invitation.email,
    };
  }

  async inviteNewMerchantAdmin(
    userId: string,
    accountantCompanyId: string,
    dto: InviteNewMerchantAdminDto,
  ): Promise<
    | {
        status: "existing_merchant";
        merchant_company: { id: string; name: string; siren: string | null };
    }
    | {
        status: "invited";
        invitation_id: string;
        email: string;
      }
  > {
    const userRole = await this.checkUserAccess(userId, accountantCompanyId);
    if (userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut inviter un nouveau commerçant depuis ce cabinet",
      );
    }

    const normalizedEmail = dto.email.trim().toLowerCase();
    const companyName = dto.company_name.trim();
    if (!companyName) {
      throw new BadRequestException("Le nom de l'entreprise est requis");
    }

    let normalizedIdentifiers: ReturnType<typeof normalizeBusinessIdentifiers>;
    try {
      normalizedIdentifiers = normalizeBusinessIdentifiers({
        siren: dto.siren,
        siret: dto.siret,
        country: dto.country,
      });
    } catch (error: any) {
      throw new BadRequestException(
        error?.message ||
          "Les identifiants SIREN/SIRET fournis sont invalides",
      );
    }

    if (!normalizedIdentifiers.siren) {
      throw new BadRequestException("Le SIREN est requis");
    }

    const existingMerchant = await this.findExistingMerchantCompanyForInvite(
      accountantCompanyId,
      normalizedIdentifiers.siren,
    );
    if (existingMerchant) {
      return {
        status: "existing_merchant",
        merchant_company: existingMerchant,
      };
    }

    const invitation = await this.createMerchantSignupInvitation(
      userId,
      accountantCompanyId,
      normalizedEmail,
      {
        company_name: companyName,
        siren: normalizedIdentifiers.siren,
        siret: normalizedIdentifiers.siret || null,
        address: dto.address?.trim() || null,
        postal_code: dto.postal_code?.trim() || null,
        city: dto.city?.trim() || null,
        country: normalizedIdentifiers.country,
      },
    );

    return {
      status: "invited",
      invitation_id: invitation.id,
      email: normalizedEmail,
    };
  }

  async getMerchantSignupInvitations(
    userId: string,
    accountantCompanyId: string,
  ): Promise<MerchantSignupInvitationSummary[]> {
    const supabase = getSupabaseAdmin();

    const userRole = await this.checkUserAccess(userId, accountantCompanyId);
    if (userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut consulter ces invitations",
      );
    }

    const { data, error } = await supabase
      .from("company_invitations")
      .select(
        "id, email, role, created_at, expires_at, signup_company_name, signup_siren, signup_city",
      )
      .eq("company_id", accountantCompanyId)
      .eq("invitation_type", "merchant_signup")
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    if (error) {
      throw new BadRequestException(
        `Erreur lors du chargement des invitations marchand: ${error.message}`,
      );
    }

    return (data || []).map((invitation: any) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role as CompanyRole,
      created_at: invitation.created_at,
      expires_at: invitation.expires_at,
      company_name: invitation.signup_company_name || null,
      siren: invitation.signup_siren || null,
      city: invitation.signup_city || null,
    }));
  }

  async cancelMerchantSignupInvitation(
    userId: string,
    accountantCompanyId: string,
    invitationId: string,
  ): Promise<{ message: string }> {
    const userRole = await this.checkUserAccess(userId, accountantCompanyId);
    if (userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut annuler ces invitations",
      );
    }

    return this.cancelCompanyInvitation(
      accountantCompanyId,
      invitationId,
      "accountant",
      ["merchant_admin"],
      ["merchant_signup"],
    );
  }

  async getLinkedClients(userId: string, companyId: string): Promise<any[]> {
    const supabase = getSupabaseAdmin();

    const userRole = await this.checkUserAccess(userId, companyId);
    if (!ACCOUNTANT_ROLES.includes(userRole)) {
      throw new ForbiddenException(
        "Seuls les comptables peuvent voir les clients liés",
      );
    }

    const { data, error } = await supabase
      .from("companies")
      .select("id, name, siren, email, city, created_at")
      .eq("accountant_company_id", companyId)
      .order("name", { ascending: true });

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return [];
    }

    const companyIds = data.map((c: any) => c.id);
    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01`;
    const endOfYear = `${currentYear}-12-31`;
    const today = new Date().toISOString().split("T")[0];

    const [invoicesRes, quotesRes, creditNotesRes] = await Promise.all([
      supabase
        .from("invoices")
        .select(
          "company_id, total, amount_paid, status, due_date, issue_date, type",
        )
        .in("company_id", companyIds),
      supabase
        .from("quotes")
        .select("company_id, total, status")
        .in("company_id", companyIds),
      supabase
        .from("invoices")
        .select("company_id, total")
        .in("company_id", companyIds)
        .eq("type", "credit_note"),
    ]);

    const invoices = invoicesRes.data || [];
    const quotes = quotesRes.data || [];
    const creditNotes = creditNotesRes.data || [];

    return data.map((company: any) => {
      const companyInvoices = invoices.filter(
        (i: any) => i.company_id === company.id && i.type !== "credit_note",
      );
      const companyQuotes = quotes.filter(
        (q: any) => q.company_id === company.id,
      );
      const companyCreditNotes = creditNotes.filter(
        (cn: any) => cn.company_id === company.id,
      );

      const annualInvoices = companyInvoices.filter(
        (i: any) =>
          i.issue_date >= startOfYear &&
          i.issue_date <= endOfYear &&
          ["sent", "paid", "overdue"].includes(i.status),
      );
      const annualRevenue = annualInvoices.reduce(
        (sum: number, i: any) => sum + Number(i.total),
        0,
      );
      const totalPaid = companyInvoices.reduce(
        (sum: number, i: any) => sum + Number(i.amount_paid || 0),
        0,
      );

      const overdueInvoices = companyInvoices.filter(
        (i: any) =>
          ["sent", "overdue"].includes(i.status) && i.due_date < today,
      );
      const overdueAmount = overdueInvoices.reduce(
        (sum: number, i: any) =>
          sum + Number(i.total) - Number(i.amount_paid || 0),
        0,
      );

      const pendingInvoices = companyInvoices.filter((i: any) =>
        ["sent"].includes(i.status),
      );
      const pendingAmount = pendingInvoices.reduce(
        (sum: number, i: any) =>
          sum + Number(i.total) - Number(i.amount_paid || 0),
        0,
      );

      return {
        ...company,
        stats: {
          invoice_count: companyInvoices.length,
          quote_count: companyQuotes.length,
          credit_note_count: companyCreditNotes.length,
          annual_revenue: Math.round(annualRevenue * 100) / 100,
          total_paid: Math.round(totalPaid * 100) / 100,
          overdue_count: overdueInvoices.length,
          overdue_amount: Math.round(overdueAmount * 100) / 100,
          pending_amount: Math.round(pendingAmount * 100) / 100,
        },
      };
    });
  }

  async unlinkLinkedClient(
    userId: string,
    accountantCompanyId: string,
    clientId: string,
  ): Promise<{ message: string }> {
    const supabase = getSupabaseAdmin();

    const userRole = await this.checkUserAccess(userId, accountantCompanyId);
    if (userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut supprimer un dossier client",
      );
    }

    await this.assertLinkedClientForAccountant(accountantCompanyId, clientId);

    const { error } = await supabase
      .from("companies")
      .update({ accountant_company_id: null })
      .eq("id", clientId)
      .eq("accountant_company_id", accountantCompanyId);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la suppression du dossier client: ${error.message}`,
      );
    }

    return { message: "Dossier client supprimé du cabinet" };
  }

  async getLinkedClientMerchantAdminInvitations(
    userId: string,
    accountantCompanyId: string,
    clientId: string,
  ): Promise<any[]> {
    const supabase = getSupabaseAdmin();

    await this.assertCanManageLinkedClientMerchantAdminInvitations(
      userId,
      accountantCompanyId,
      clientId,
    );

    const { data, error } = await supabase
      .from("company_invitations")
      .select("id, email, role, created_at, expires_at")
      .eq("company_id", clientId)
      .eq("role", "merchant_admin")
      .eq("invitation_type", "member")
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    if (error) {
      throw new BadRequestException(
        `Erreur lors du chargement des invitations admin marchand: ${error.message}`,
      );
    }

    return data || [];
  }

  async inviteLinkedClientMerchantAdmin(
    userId: string,
    accountantCompanyId: string,
    clientId: string,
    email: string,
  ): Promise<any> {
    await this.assertCanManageLinkedClientMerchantAdminInvitations(
      userId,
      accountantCompanyId,
      clientId,
    );

    return this.createCompanyInvitation(
      userId,
      clientId,
      email,
      "merchant_admin",
      "merchant_admin",
    );
  }

  async cancelLinkedClientMerchantAdminInvitation(
    userId: string,
    accountantCompanyId: string,
    clientId: string,
    invitationId: string,
  ): Promise<{ message: string }> {
    await this.assertCanManageLinkedClientMerchantAdminInvitations(
      userId,
      accountantCompanyId,
      clientId,
    );

    return this.cancelCompanyInvitation(
      clientId,
      invitationId,
      "merchant_admin",
      ["merchant_admin"],
    );
  }

  async getAccountantLinkRequests(
    userId: string,
    companyId: string,
    direction: "incoming" | "outgoing",
  ) {
    const supabase = getSupabaseAdmin();
    const userRole = await this.checkUserAccess(userId, companyId);

    if (direction === "incoming" && userRole !== "merchant_admin") {
      throw new ForbiddenException(
        "Seul un administrateur commerçant peut consulter les demandes de liaison entrantes",
      );
    }

    if (direction === "outgoing" && userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut consulter les demandes de liaison sortantes",
      );
    }

    const column =
      direction === "incoming"
        ? "merchant_company_id"
        : "accountant_company_id";
    const { data, error } = await supabase
      .from("accountant_link_requests")
      .select(
        "id, accountant_company_id, merchant_company_id, request_origin, requested_by, status, created_at, responded_at, responded_by",
      )
      .eq(column, companyId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) {
      throw new BadRequestException(
        `Erreur lors du chargement des demandes de liaison: ${error.message}`,
      );
    }

    return this.hydrateAccountantLinkRequests(
      (data || []) as AccountantLinkRequestEntity[],
    );
  }

  async searchMerchants(
    userId: string,
    accountantCompanyId: string,
    query: string,
  ): Promise<AccountantLinkRequestCompanySummary[]> {
    const supabase = getSupabaseAdmin();
    const userRole = await this.checkUserAccess(userId, accountantCompanyId);

    if (userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut rechercher des commerçants",
      );
    }

    if (!query || query.trim().length < 2) {
      return [];
    }

    let searchTerm = query.trim();
    const digitsOnly = searchTerm.replace(/\D/g, "");
    if (digitsOnly.length === 14) {
      searchTerm = digitsOnly.slice(0, 9);
    } else if (digitsOnly.length === 9) {
      searchTerm = digitsOnly;
    }

    const { data: merchantCompanyIds, error: merchantIdsError } = await supabase
      .from("user_companies")
      .select("company_id")
      .eq("role", "merchant_admin");

    if (merchantIdsError) {
      throw new BadRequestException(
        `Erreur lors de la recherche des commerçants: ${merchantIdsError.message}`,
      );
    }

    const companyIds = Array.from(
      new Set(
        (merchantCompanyIds || []).map((relation: any) => relation.company_id),
      ),
    ).filter((companyId) => companyId && companyId !== accountantCompanyId);

    if (companyIds.length === 0) {
      return [];
    }

    const { data: pendingRequests } = await supabase
      .from("accountant_link_requests")
      .select("merchant_company_id")
      .eq("accountant_company_id", accountantCompanyId)
      .eq("status", "pending");

    const pendingMerchantIds = new Set(
      (pendingRequests || []).map(
        (request: any) => request.merchant_company_id,
      ),
    );

    const { data, error } = await supabase
      .from("companies")
      .select(
        "id, name, legal_name, siren, email, city, logo_url, accountant_company_id",
      )
      .in("id", companyIds)
      .is("accountant_company_id", null)
      .or(
        `name.ilike.%${searchTerm}%,legal_name.ilike.%${searchTerm}%,siren.ilike.%${searchTerm}%`,
      )
      .limit(10);

    if (error) {
      throw new BadRequestException(
        `Erreur lors de la recherche des commerçants: ${error.message}`,
      );
    }

    return (data || [])
      .filter((company: any) => !pendingMerchantIds.has(company.id))
      .map((company: any) => ({
        id: company.id,
        name: company.name,
        legal_name: company.legal_name || null,
        siren: company.siren || null,
        email: company.email || null,
        city: company.city || null,
        logo_url: company.logo_url || null,
      }));
  }

  async createAccountantLinkRequest(
    userId: string,
    accountantCompanyId: string,
    merchantCompanyId: string,
  ) {
    const supabase = getSupabaseAdmin();
    const userRole = await this.checkUserAccess(userId, accountantCompanyId);

    if (userRole !== "accountant") {
      throw new ForbiddenException(
        "Seul un expert-comptable administrateur peut envoyer une demande de liaison",
      );
    }

    if (accountantCompanyId === merchantCompanyId) {
      throw new BadRequestException(
        "Une entreprise ne peut pas se demander une liaison à elle-même",
      );
    }

    const { data: merchantCompany, error: merchantError } = await supabase
      .from("companies")
      .select(
        "id, name, legal_name, siren, email, city, logo_url, accountant_company_id",
      )
      .eq("id", merchantCompanyId)
      .single();

    if (merchantError || !merchantCompany) {
      throw new NotFoundException("Entreprise commerçante introuvable");
    }

    const { data: merchantAdminRelation } = await supabase
      .from("user_companies")
      .select("company_id")
      .eq("company_id", merchantCompanyId)
      .eq("role", "merchant_admin")
      .limit(1)
      .maybeSingle();

    if (!merchantAdminRelation) {
      throw new NotFoundException(
        "Cette entreprise n’est pas un commerçant éligible",
      );
    }

    if (merchantCompany.accountant_company_id) {
      throw new ConflictException(
        "Ce commerçant est déjà lié à un cabinet comptable",
      );
    }

    const { data: existingPendingRequest } = await supabase
      .from("accountant_link_requests")
      .select("id")
      .eq("accountant_company_id", accountantCompanyId)
      .eq("merchant_company_id", merchantCompanyId)
      .eq("status", "pending")
      .maybeSingle();

    if (existingPendingRequest) {
      throw new ConflictException(
        "Une demande de liaison est déjà en attente pour ce commerçant",
      );
    }

    const request = await this.createAccountantLinkRequestRecord(
      userId,
      accountantCompanyId,
      merchantCompanyId,
      "existing_merchant",
    );

    const [hydratedRequest] = await this.hydrateAccountantLinkRequests([
      request,
    ]);
    return hydratedRequest;
  }

  async acceptAccountantLinkRequest(
    userId: string,
    merchantCompanyId: string,
    requestId: string,
  ) {
    return this.respondToAccountantLinkRequest(
      userId,
      merchantCompanyId,
      requestId,
      "accepted",
    );
  }

  async rejectAccountantLinkRequest(
    userId: string,
    merchantCompanyId: string,
    requestId: string,
  ) {
    return this.respondToAccountantLinkRequest(
      userId,
      merchantCompanyId,
      requestId,
      "rejected",
    );
  }

  async getLinkedClientDocuments(
    userId: string,
    companyId: string,
    clientId: string,
    params: AccountantDocumentsQueryDto,
  ): Promise<AccountantDocumentsResponse> {
    const userRole = await this.checkUserAccess(userId, companyId);
    if (!ACCOUNTANT_ROLES.includes(userRole)) {
      throw new ForbiddenException(
        "Seuls les comptables peuvent voir les documents des clients",
      );
    }

    await this.assertLinkedClientForAccountant(companyId, clientId);

    const page = params.page || 1;
    const limit = params.limit || 20;
    const offset = (page - 1) * limit;
    const documents = await this.loadAccountantDocuments(clientId, params);
    const paginatedDocuments = documents.slice(offset, offset + limit);
    const downloadableTotal = documents.filter(
      (document) => document.storage_available,
    ).length;

    return {
      data: paginatedDocuments,
      total: documents.length,
      downloadable_total: downloadableTotal,
      page,
      limit,
      total_pages: Math.ceil(documents.length / limit),
    };
  }

  async downloadLinkedClientDocumentsZip(
    userId: string,
    response: Response,
    companyId: string,
    clientId: string,
    params: BulkDownloadLinkedClientDocumentsDto,
  ): Promise<void> {
    const supabase = getSupabaseAdmin();
    const userRole = await this.checkUserAccess(userId, companyId);
    if (!ACCOUNTANT_ROLES.includes(userRole)) {
      throw new ForbiddenException(
        "Seuls les comptables peuvent télécharger les documents des clients",
      );
    }

    await this.assertLinkedClientForAccountant(companyId, clientId);

    const selectedIds = Array.from(new Set(params.document_ids || []));
    if (selectedIds.length > 100) {
      throw new BadRequestException(
        "Le téléchargement groupé est limité à 100 documents",
      );
    }

    const allFilteredDocuments = await this.loadAccountantDocuments(
      clientId,
      params,
    );
    const selectedIdSet = new Set(selectedIds);
    const selectedDocuments =
      selectedIds.length > 0
        ? allFilteredDocuments.filter((document) =>
            selectedIdSet.has(document.id),
          )
        : allFilteredDocuments;

    const skippedLines: string[] = [];
    if (selectedIds.length > 0) {
      const foundIds = new Set(
        selectedDocuments.map((document) => document.id),
      );
      selectedIds.forEach((documentId) => {
        if (!foundIds.has(documentId)) {
          skippedLines.push(
            `Document sélectionné introuvable ou hors filtre: ${documentId}`,
          );
        }
      });
    }

    const downloadableDocuments = selectedDocuments.filter(
      (document) => document.storage_available,
    );
    if (selectedIds.length === 0 && downloadableDocuments.length > 100) {
      throw new BadRequestException(
        "Trop de documents archivés correspondent à ces filtres. Affinez votre recherche pour rester sous 100 documents.",
      );
    }

    if (selectedIds.length > 0 && downloadableDocuments.length > 100) {
      throw new BadRequestException(
        "Le téléchargement groupé est limité à 100 documents",
      );
    }

    if (selectedDocuments.length === 0 || downloadableDocuments.length === 0) {
      throw new BadRequestException(
        "Aucun document archivé disponible pour le téléchargement groupé",
      );
    }

    const storedDocumentsMap = await this.getStoredAccountantDocumentsMap(
      clientId,
      downloadableDocuments.map((document) => document.id),
    );

    const { data: clientCompany } = await supabase
      .from("companies")
      .select("name")
      .eq("id", clientId)
      .maybeSingle();

    const archiveYear = params.year || new Date().getFullYear();
    const archivePeriod = params.period || "year";
    const archiveClientName = this.sanitizeDownloadFilename(
      clientCompany?.name || "client",
      "client",
    );
    const archiveFilename = `documents-${archiveClientName}-${archiveYear}-${archivePeriod}.zip`;
    const usedNames = new Map<string, number>();

    let firstSuccessfulEntry: { filename: string; buffer: Buffer } | null =
      null;
    let firstSuccessfulIndex = -1;

    for (let index = 0; index < downloadableDocuments.length; index += 1) {
      const document = downloadableDocuments[index];
      const storedDocument = storedDocumentsMap.get(document.id);
      if (!storedDocument?.storage_path) {
        skippedLines.push(
          `Document ignoré (PDF archivé introuvable): ${document.invoice_number}`,
        );
        continue;
      }

      const { data: fileData, error: downloadError } = await supabase.storage
        .from(this.documentsBucket)
        .download(storedDocument.storage_path);

      if (downloadError || !fileData) {
        skippedLines.push(
          `Document ignoré (${document.invoice_number}): ${downloadError?.message || "PDF introuvable dans le storage"}`,
        );
        continue;
      }

      firstSuccessfulEntry = {
        filename: this.buildUniqueArchiveFilename(
          storedDocument.filename ||
            document.downloadable_filename ||
            this.buildAccountantDownloadFilename(document),
          usedNames,
        ),
        buffer: Buffer.from(await fileData.arrayBuffer()),
      };
      firstSuccessfulIndex = index;
      break;
    }

    if (!firstSuccessfulEntry) {
      throw new BadRequestException(
        "Aucun document archivé disponible pour le téléchargement groupé",
      );
    }

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("warning", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        response.destroy(error as Error);
      }
    });
    archive.on("error", (error) => {
      response.destroy(error);
    });

    response.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${archiveFilename}"`,
    });
    archive.pipe(response);
    archive.append(firstSuccessfulEntry.buffer, {
      name: firstSuccessfulEntry.filename,
    });

    for (
      let index = firstSuccessfulIndex + 1;
      index < downloadableDocuments.length;
      index += 1
    ) {
      const document = downloadableDocuments[index];
      const storedDocument = storedDocumentsMap.get(document.id);
      if (!storedDocument?.storage_path) {
        skippedLines.push(
          `Document ignoré (PDF archivé introuvable): ${document.invoice_number}`,
        );
        continue;
      }

      const { data: fileData, error: downloadError } = await supabase.storage
        .from(this.documentsBucket)
        .download(storedDocument.storage_path);

      if (downloadError || !fileData) {
        skippedLines.push(
          `Document ignoré (${document.invoice_number}): ${downloadError?.message || "PDF introuvable dans le storage"}`,
        );
        continue;
      }

      archive.append(Buffer.from(await fileData.arrayBuffer()), {
        name: this.buildUniqueArchiveFilename(
          storedDocument.filename ||
            document.downloadable_filename ||
            this.buildAccountantDownloadFilename(document),
          usedNames,
        ),
      });
    }

    const unavailableSelectedDocuments = selectedDocuments.filter(
      (document) => !document.storage_available,
    );
    unavailableSelectedDocuments.forEach((document) => {
      skippedLines.push(
        `Document ignoré (PDF non archivé): ${document.invoice_number}`,
      );
    });

    if (skippedLines.length > 0) {
      archive.append(Buffer.from(skippedLines.join("\n"), "utf-8"), {
        name: "erreurs.txt",
      });
    }

    await archive.finalize();
  }

  async downloadLinkedClientDocument(
    userId: string,
    companyId: string,
    clientId: string,
    documentId: string,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const supabase = getSupabaseAdmin();

    const userRole = await this.checkUserAccess(userId, companyId);
    if (!ACCOUNTANT_ROLES.includes(userRole)) {
      throw new ForbiddenException(
        "Seuls les comptables peuvent télécharger les documents des clients",
      );
    }

    await this.assertLinkedClientForAccountant(companyId, clientId);

    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("id, company_id, invoice_number, status, type")
      .eq("id", documentId)
      .eq("company_id", clientId)
      .neq("status", "draft")
      .single();

    if (invoiceError || !invoice) {
      throw new NotFoundException("Document comptable introuvable");
    }

    const storedDocuments = await this.getStoredAccountantDocumentsMap(
      clientId,
      [invoice.id],
    );
    const storedDocument = storedDocuments.get(invoice.id);

    if (!storedDocument?.storage_path) {
      throw new NotFoundException(
        "Le PDF immuable n’est pas disponible pour ce document",
      );
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from(this.documentsBucket)
      .download(storedDocument.storage_path);

    if (downloadError || !fileData) {
      throw new NotFoundException(
        "Le document stocké est introuvable dans le storage",
      );
    }

    return {
      buffer: Buffer.from(await fileData.arrayBuffer()),
      filename:
        storedDocument.filename ||
        this.buildAccountantDownloadFilename(invoice),
      mimeType: storedDocument.mime_type || "application/pdf",
    };
  }

  // ============================================
  // Member management (invite / list / remove)
  // ============================================

  async validateInviteToken(token: string): Promise<{
    email: string;
    role: CompanyRole;
    invitation_type: InvitationType;
    company_id: string;
    company_name: string;
    inviter_name: string;
    expires_at: string;
    invited_firm_name?: string | null;
    invited_firm_siren?: string | null;
    signup_company_name?: string | null;
    signup_siren?: string | null;
    signup_siret?: string | null;
    signup_address?: string | null;
    signup_postal_code?: string | null;
    signup_city?: string | null;
    signup_country?: string | null;
  } | null> {
    const supabase = getSupabaseAdmin();

    const { data: invitation, error } = await supabase
      .from("company_invitations")
      .select(
        "company_id, email, role, invitation_type, expires_at, invited_by, invited_firm_name, invited_firm_siren, signup_company_name, signup_siren, signup_siret, signup_address, signup_postal_code, signup_city, signup_country, company:companies(name)",
      )
      .eq("token", token)
      .eq("billing_status", "settled")
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (error || !invitation) {
      return null;
    }

    const { data: inviter } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", invitation.invited_by)
      .maybeSingle();

    const inviterName =
      [inviter?.first_name, inviter?.last_name].filter(Boolean).join(" ") ||
      "Un administrateur";

    return {
      company_id: invitation.company_id,
      email: invitation.email,
      role: invitation.role as CompanyRole,
      invitation_type: ((invitation as any).invitation_type ||
        "member") as InvitationType,
      company_name: (invitation.company as any)?.name || "Entreprise",
      inviter_name: inviterName,
      expires_at: invitation.expires_at,
      invited_firm_name: (invitation as any).invited_firm_name || null,
      invited_firm_siren: (invitation as any).invited_firm_siren || null,
      signup_company_name: (invitation as any).signup_company_name || null,
      signup_siren: (invitation as any).signup_siren || null,
      signup_siret: (invitation as any).signup_siret || null,
      signup_address: (invitation as any).signup_address || null,
      signup_postal_code: (invitation as any).signup_postal_code || null,
      signup_city: (invitation as any).signup_city || null,
      signup_country: (invitation as any).signup_country || null,
    };
  }

  async getMembers(userId: string, companyId: string): Promise<any[]> {
    const supabase = getSupabaseAdmin();

    const accessContext = await this.checkUserAccessContext(userId, companyId);

    const { data: members, error } = await supabase
      .from("user_companies")
      .select(
        `
                id,
                role,
                is_default,
                created_at,
                user_id,
                profile:profiles!user_companies_user_id_fkey(
                    id, email, first_name, last_name, avatar_url
                )
            `,
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: true });

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    // Also fetch pending invitations
    const { data: invitations } = await supabase
      .from("company_invitations")
      .select("id, email, role, created_at, expires_at, billing_status")
      .eq("company_id", companyId)
      .eq("invitation_type", "member")
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    const mappedMembers = (members || []).map((m: any) => ({
      id: m.id,
      user_id: m.user_id,
      role: m.role,
      is_default: m.is_default,
      created_at: m.created_at,
      email: m.profile?.email || null,
      first_name: m.profile?.first_name || null,
      last_name: m.profile?.last_name || null,
      avatar_url: m.profile?.avatar_url || null,
    }));
    const pendingInvitations = invitations || [];

    const { data: company } = await supabase
      .from("companies")
      .select("owner_id")
      .eq("id", companyId)
      .maybeSingle();

    let quota: {
      max_members: number | null;
      current_members: number;
      pending_invitations: number;
    } | null = null;

    if (accessContext.companyOwnerRole === "accountant") {
      quota = {
        max_members: null,
        current_members: mappedMembers.length,
        pending_invitations: pendingInvitations.length,
      };
    } else if (company?.owner_id) {
      const { data: subscription } = await supabase
        .from("subscriptions")
        .select("plan_id, subscription_plans(*)")
        .eq("user_id", company.owner_id)
        .maybeSingle();

      const plan = subscription?.subscription_plans as any;
      quota = {
        max_members: plan?.max_members ?? null,
        current_members: mappedMembers.length,
        pending_invitations: pendingInvitations.length,
      };
    }

    return {
      members: mappedMembers,
      invitations: pendingInvitations,
      quota,
    } as any;
  }

  async inviteMember(
    userId: string,
    companyId: string,
    email: string,
    role: CompanyRole,
    inviterEmail?: string | null,
  ): Promise<any> {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedInviterEmail = inviterEmail?.trim().toLowerCase() || null;

    const accessContext = await this.checkUserAccessContext(userId, companyId);
    const canInviteRequestedSuperadmin =
      role === "superadmin" &&
      canInviteSuperadminRole(
        normalizedInviterEmail,
        accessContext.companyOwnerRole,
      );

    if (role === "superadmin" && !canInviteRequestedSuperadmin) {
      throw new ForbiddenException(
        "Seul le compte superadmin racine peut inviter un superadmin",
      );
    }

    if (!canInviteRequestedSuperadmin) {
      this.ensureCanManageMembers(
        accessContext.role,
        accessContext.companyOwnerRole,
      );
    }

    if (
      !canInviteRequestedSuperadmin &&
      !getInvitableRolesForCompanyType(accessContext.companyOwnerRole).includes(
        role,
      )
    ) {
      throw new ForbiddenException(
        accessContext.companyOwnerRole === "accountant"
          ? "Un cabinet ne peut inviter que des experts-comptables ou des collaborateurs comptables"
          : "Rôle d’invitation non autorisé pour cette entreprise",
      );
    }

    return this.createCompanyInvitation(
      userId,
      companyId,
      normalizedEmail,
      role,
      accessContext.companyOwnerRole,
    );
  }

  async removeMember(
    userId: string,
    companyId: string,
    memberUserId: string,
  ): Promise<{ message: string }> {
    const supabase = getSupabaseAdmin();

    const accessContext = await this.checkUserAccessContext(userId, companyId);
    this.ensureCanManageMembers(
      accessContext.role,
      accessContext.companyOwnerRole,
    );

    if (userId === memberUserId) {
      throw new BadRequestException(
        "Vous ne pouvez pas vous retirer vous-même",
      );
    }

    const { error } = await supabase
      .from("user_companies")
      .delete()
      .eq("user_id", memberUserId)
      .eq("company_id", companyId);

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    // Sync member count to Stripe billing
    if (this.shouldSyncMemberQuantity(accessContext.companyOwnerRole)) {
      try {
        await this.subscriptionService.syncMemberQuantity(companyId);
      } catch (e) {
        console.error("Erreur synchronisation facturation après retrait membre", {
          companyId,
          memberUserId,
          error: this.extractErrorMessage(e),
        });
      }
    }

    return { message: "Membre retiré avec succès" };
  }

  async updateMemberRole(
    userId: string,
    companyId: string,
    memberUserId: string,
    nextRole: Exclude<CompanyRole, "superadmin">,
  ): Promise<{ message: string }> {
    const supabase = getSupabaseAdmin();
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    this.ensureCanManageMembers(
      accessContext.role,
      accessContext.companyOwnerRole,
    );

    const allowedRoles = getInvitableRolesForCompanyType(
      accessContext.companyOwnerRole,
    );
    if (!allowedRoles.includes(nextRole)) {
      throw new ForbiddenException("Rôle non autorisé pour cette entreprise");
    }

    const { data: member, error: memberError } = await supabase
      .from("user_companies")
      .select("role")
      .eq("user_id", memberUserId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (memberError) {
      throw new BadRequestException(`Erreur: ${memberError.message}`);
    }

    if (!member) {
      throw new NotFoundException("Membre introuvable");
    }

    const currentRole = member.role as CompanyRole;
    const adminRole =
      accessContext.companyOwnerRole === "accountant"
        ? "accountant"
        : "merchant_admin";

    if (currentRole === adminRole && nextRole !== adminRole) {
      const { count, error: countError } = await supabase
        .from("user_companies")
        .select("*", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("role", adminRole);

      if (countError) {
        throw new BadRequestException(`Erreur: ${countError.message}`);
      }

      if ((count || 0) <= 1) {
        throw new BadRequestException(
          "Cette entreprise doit conserver au moins un administrateur",
        );
      }
    }

    const { error } = await supabase
      .from("user_companies")
      .update({ role: nextRole })
      .eq("user_id", memberUserId)
      .eq("company_id", companyId);

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    return { message: "Rôle mis à jour" };
  }

  async cancelInvitation(
    userId: string,
    companyId: string,
    invitationId: string,
  ): Promise<{ message: string }> {
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    this.ensureCanManageMembers(
      accessContext.role,
      accessContext.companyOwnerRole,
    );

    return this.cancelCompanyInvitation(
      companyId,
      invitationId,
      accessContext.companyOwnerRole,
    );
  }

  async finalizeMemberInvitation(
    userId: string,
    companyId: string,
    invitationId: string,
  ): Promise<any> {
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    this.ensureCanManageMembers(
      accessContext.role,
      accessContext.companyOwnerRole,
    );

    const supabase = getSupabaseAdmin();
    const { data: invitation, error } = await supabase
      .from("company_invitations")
      .select("*")
      .eq("id", invitationId)
      .eq("company_id", companyId)
      .eq("invitation_type", "member")
      .is("accepted_at", null)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    if (!invitation) {
      throw new NotFoundException("Invitation introuvable");
    }

    if (this.shouldSyncMemberQuantity(accessContext.companyOwnerRole)) {
      const billingSettled =
        await this.subscriptionService.isMemberQuantityBillingSettled(
          companyId,
        );

      if (!billingSettled) {
        throw new BadRequestException(
          "Le paiement du membre supplémentaire doit être confirmé avant l’envoi de l’invitation",
        );
      }

      const { error: billingStatusError } = await supabase
        .from("company_invitations")
        .update({ billing_status: "settled" })
        .eq("id", invitation.id);

      if (billingStatusError) {
        throw new BadRequestException(
          `Erreur lors de la validation du paiement de l'invitation: ${billingStatusError.message}`,
        );
      }

      invitation.billing_status = "settled";
    }

    return this.deliverMemberInvitation(
      userId,
      companyId,
      invitation,
      accessContext.companyOwnerRole,
    );
  }

  async resendMemberInvitation(
    userId: string,
    companyId: string,
    invitationId: string,
  ): Promise<{ message: string }> {
    const accessContext = await this.checkUserAccessContext(userId, companyId);
    this.ensureCanManageMembers(
      accessContext.role,
      accessContext.companyOwnerRole,
    );

    const supabase = getSupabaseAdmin();
    const { data: invitation, error } = await supabase
      .from("company_invitations")
      .select(
        "id, company_id, email, role, token, expires_at, accepted_at, invitation_type",
      )
      .eq("id", invitationId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    if (!invitation) {
      throw new NotFoundException("Invitation introuvable");
    }

    if (((invitation as any).invitation_type || "member") !== "member") {
      throw new NotFoundException("Invitation introuvable");
    }

    if (invitation.accepted_at) {
      throw new BadRequestException("Cette invitation a déjà été acceptée");
    }

    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw new BadRequestException("Cette invitation a expiré");
    }

    await this.sendMemberInvitationEmail(
      userId,
      companyId,
      invitation.email,
      invitation.role as CompanyRole,
      invitation.token,
    );

    return { message: "Invitation renvoyée" };
  }

  async searchAccountants(
    query: string,
  ): Promise<{ id: string; name: string; siren: string | null }[]> {
    if (!query || query.trim().length < 2) return [];

    const supabase = getSupabaseAdmin();
    let searchTerm = query.trim();

    // Si c'est un SIRET (14 chiffres), extraire le SIREN (9 premiers)
    const digitsOnly = searchTerm.replace(/\D/g, "");
    if (digitsOnly.length === 14) {
      searchTerm = digitsOnly.substring(0, 9);
    } else if (digitsOnly.length === 9) {
      searchTerm = digitsOnly;
    }

    // Chercher les entreprises qui ont au moins un membre avec le rôle "accountant"
    const { data: accountantCompanyIds } = await supabase
      .from("user_companies")
      .select("company_id")
      .eq("role", "accountant");

    if (!accountantCompanyIds || accountantCompanyIds.length === 0) return [];

    const companyIds = accountantCompanyIds.map((uc: any) => uc.company_id);

    // Chercher par nom ou SIREN parmi ces entreprises
    const { data, error } = await supabase
      .from("companies")
      .select("id, name, siren")
      .in("id", companyIds)
      .or(`name.ilike.%${searchTerm}%,siren.ilike.%${searchTerm}%`)
      .limit(10);

    if (error || !data) return [];

    return data.map((c: any) => ({
      id: c.id,
      name: c.name,
      siren: c.siren,
    }));
  }

  private async respondToAccountantLinkRequest(
    userId: string,
    merchantCompanyId: string,
    requestId: string,
    decision: "accepted" | "rejected",
  ) {
    const supabase = getSupabaseAdmin();
    const userRole = await this.checkUserAccess(userId, merchantCompanyId);

    if (userRole !== "merchant_admin") {
      throw new ForbiddenException(
        "Seul un administrateur commerçant peut répondre à une demande de liaison",
      );
    }

    const { data: request, error: requestError } = await supabase
      .from("accountant_link_requests")
      .select(
        "id, accountant_company_id, merchant_company_id, request_origin, requested_by, status, created_at, responded_at, responded_by",
      )
      .eq("id", requestId)
      .eq("merchant_company_id", merchantCompanyId)
      .single();

    if (requestError || !request) {
      throw new NotFoundException("Demande de liaison introuvable");
    }

    if (request.status !== "pending") {
      throw new ConflictException(
        "Cette demande de liaison a déjà été traitée",
      );
    }

    if (decision === "accepted") {
      const { data: merchantCompany, error: merchantError } = await supabase
        .from("companies")
        .select("accountant_company_id")
        .eq("id", merchantCompanyId)
        .single();

      if (merchantError || !merchantCompany) {
        throw new NotFoundException("Entreprise commerçante introuvable");
      }

      if (merchantCompany.accountant_company_id) {
        throw new ConflictException(
          "Cette entreprise est déjà liée à un cabinet comptable",
        );
      }

      const { error: linkError } = await supabase
        .from("companies")
        .update({ accountant_company_id: request.accountant_company_id })
        .eq("id", merchantCompanyId);

      if (linkError) {
        throw new BadRequestException(
          `Erreur lors de l’acceptation de la liaison: ${linkError.message}`,
        );
      }
    }

    const respondedAt = new Date().toISOString();
    const { data: updatedRequest, error: updateError } = await supabase
      .from("accountant_link_requests")
      .update({
        status: decision,
        responded_at: respondedAt,
        responded_by: userId,
      })
      .eq("id", requestId)
      .select(
        "id, accountant_company_id, merchant_company_id, request_origin, requested_by, status, created_at, responded_at, responded_by",
      )
      .single();

    if (updateError || !updatedRequest) {
      throw new BadRequestException(
        `Erreur lors de la mise à jour de la demande de liaison: ${updateError?.message || "inconnue"}`,
      );
    }

    if (decision === "accepted") {
      await supabase
        .from("accountant_link_requests")
        .update({
          status: "cancelled",
          responded_at: respondedAt,
          responded_by: userId,
        })
        .eq("merchant_company_id", merchantCompanyId)
        .eq("status", "pending")
        .neq("id", requestId);
    }

    const [hydratedRequest] = await this.hydrateAccountantLinkRequests([
      updatedRequest as AccountantLinkRequestEntity,
    ]);
    return hydratedRequest;
  }

  async acceptNewClientInvitationLinkRequest(
    merchantCompanyId: string,
    requestedBy: string,
    respondedBy: string,
  ): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: request, error: requestError } = await supabase
      .from("accountant_link_requests")
      .select(
        "id, accountant_company_id, merchant_company_id, request_origin, requested_by, status, created_at, responded_at, responded_by",
      )
      .eq("merchant_company_id", merchantCompanyId)
      .eq("requested_by", requestedBy)
      .eq("request_origin", "new_client_invitation")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (requestError) {
      throw new BadRequestException(
        `Erreur lors du chargement de la demande de liaison invitée: ${requestError.message}`,
      );
    }

    if (!request) {
      return;
    }

    const { data: merchantCompany, error: merchantError } = await supabase
      .from("companies")
      .select("accountant_company_id")
      .eq("id", merchantCompanyId)
      .single();

    if (merchantError || !merchantCompany) {
      throw new NotFoundException("Entreprise commerçante introuvable");
    }

    if (!merchantCompany.accountant_company_id) {
      const { error: linkError } = await supabase
        .from("companies")
        .update({ accountant_company_id: request.accountant_company_id })
        .eq("id", merchantCompanyId);

      if (linkError) {
        throw new BadRequestException(
          `Erreur lors du rattachement du dossier client: ${linkError.message}`,
        );
      }
    }

    const respondedAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("accountant_link_requests")
      .update({
        status: "accepted",
        responded_at: respondedAt,
        responded_by: respondedBy,
      })
      .eq("id", request.id);

    if (updateError) {
      throw new BadRequestException(
        `Erreur lors de l’acceptation de la demande de liaison invitée: ${updateError.message}`,
      );
    }

    await supabase
      .from("accountant_link_requests")
      .update({
        status: "cancelled",
        responded_at: respondedAt,
        responded_by: respondedBy,
      })
      .eq("merchant_company_id", merchantCompanyId)
      .eq("status", "pending")
      .neq("id", request.id);
  }

  private async findExistingAccountantCompany(
    siren: string,
    email: string,
  ): Promise<{ id: string; name: string; siren: string | null } | null> {
    const supabase = getSupabaseAdmin();

    const { data: accountantCompanyIds } = await supabase
      .from("user_companies")
      .select("company_id")
      .eq("role", "accountant");

    if (!accountantCompanyIds || accountantCompanyIds.length === 0) {
      return null;
    }

    const companyIds = accountantCompanyIds.map((uc: any) => uc.company_id);

    const { data: bySiren } = await supabase
      .from("companies")
      .select("id, name, siren, email")
      .in("id", companyIds)
      .eq("siren", siren)
      .limit(1)
      .maybeSingle();

    if (bySiren) {
      return {
        id: bySiren.id,
        name: bySiren.name,
        siren: bySiren.siren || null,
      };
    }

    const { data: byEmail } = await supabase
      .from("companies")
      .select("id, name, siren, email")
      .in("id", companyIds)
      .ilike("email", email)
      .limit(1)
      .maybeSingle();

    if (!byEmail) return null;

    return {
      id: byEmail.id,
      name: byEmail.name,
      siren: byEmail.siren || null,
    };
  }

  private async findExistingMerchantCompanyForInvite(
    accountantCompanyId: string,
    siren: string,
  ): Promise<{ id: string; name: string; siren: string | null } | null> {
    const supabase = getSupabaseAdmin();

    const { data: existingCompany, error: companyError } = await supabase
      .from("companies")
      .select("id, name, siren, accountant_company_id")
      .eq("siren", siren)
      .limit(1)
      .maybeSingle();

    if (companyError) {
      throw new BadRequestException(
        `Erreur lors de la recherche du commerçant: ${companyError.message}`,
      );
    }

    if (!existingCompany) {
      return null;
    }

    if (existingCompany.id === accountantCompanyId) {
      throw new ConflictException(
        "Le SIREN sélectionné correspond à votre propre cabinet",
      );
    }

    const { data: merchantCompanyIds, error: merchantIdsError } = await supabase
      .from("user_companies")
      .select("company_id")
      .eq("role", "merchant_admin");

    if (merchantIdsError) {
      throw new BadRequestException(
        `Erreur lors de la recherche des commerçants: ${merchantIdsError.message}`,
      );
    }

    const merchantIds = new Set(
      (merchantCompanyIds || []).map((relation: any) => relation.company_id),
    );

    if (!merchantIds.has(existingCompany.id)) {
      throw new ConflictException(
        "Une entreprise avec ce SIREN existe déjà sur la plateforme mais n’est pas éligible comme commerçant",
      );
    }

    if (existingCompany.accountant_company_id) {
      if (existingCompany.accountant_company_id === accountantCompanyId) {
        throw new ConflictException(
          "Cette entreprise est déjà liée à votre cabinet",
        );
      }

      throw new ConflictException(
        "Cette entreprise est déjà liée à un autre cabinet",
      );
    }

    const { data: pendingRequest, error: pendingRequestError } = await supabase
      .from("accountant_link_requests")
      .select("id")
      .eq("accountant_company_id", accountantCompanyId)
      .eq("merchant_company_id", existingCompany.id)
      .eq("status", "pending")
      .maybeSingle();

    if (pendingRequestError) {
      throw new BadRequestException(
        `Erreur lors de la vérification des demandes de liaison: ${pendingRequestError.message}`,
      );
    }

    if (pendingRequest) {
      throw new ConflictException(
        "Une demande de liaison est déjà en attente pour cette entreprise",
      );
    }

    return {
      id: existingCompany.id,
      name: existingCompany.name,
      siren: existingCompany.siren || null,
    };
  }

  private async hydrateAccountantLinkRequests(
    requests: AccountantLinkRequestEntity[],
  ) {
    if (requests.length === 0) {
      return [];
    }

    const supabase = getSupabaseAdmin();
    const companyIds = Array.from(
      new Set(
        requests.flatMap((request) => [
          request.accountant_company_id,
          request.merchant_company_id,
        ]),
      ),
    );

    const { data: companies, error } = await supabase
      .from("companies")
      .select("id, name, legal_name, siren, email, city, logo_url")
      .in("id", companyIds);

    if (error) {
      throw new BadRequestException(
        `Erreur lors du chargement des sociétés liées aux demandes: ${error.message}`,
      );
    }

    const summaries = new Map<string, AccountantLinkRequestCompanySummary>(
      (companies || []).map((company: any) => [
        company.id,
        {
          id: company.id,
          name: company.name,
          legal_name: company.legal_name || null,
          siren: company.siren || null,
          email: company.email || null,
          city: company.city || null,
          logo_url: company.logo_url || null,
        },
      ]),
    );

    return requests.map((request) => ({
      ...request,
      accountant_company: summaries.get(request.accountant_company_id) || {
        id: request.accountant_company_id,
        name: "Cabinet comptable",
        legal_name: null,
        siren: null,
        email: null,
        city: null,
        logo_url: null,
      },
      merchant_company: summaries.get(request.merchant_company_id) || {
        id: request.merchant_company_id,
        name: "Entreprise commerçante",
        legal_name: null,
        siren: null,
        email: null,
        city: null,
        logo_url: null,
      },
    }));
  }

  private ensureCanManageMembers(
    userRole: CompanyRole,
    companyOwnerRole: CompanyOwnerRole,
  ): void {
    if (!canManageMembers(userRole, companyOwnerRole)) {
      throw new ForbiddenException(
        companyOwnerRole === "accountant"
          ? "Seul l’expert-comptable administrateur peut gérer les membres de ce cabinet"
          : "Seuls les administrateurs marchands peuvent gérer les membres de cette entreprise",
      );
    }
  }

  private async createCompanyInvitation(
    userId: string,
    companyId: string,
    email: string,
    role: CompanyRole,
    companyOwnerRole: CompanyOwnerRole,
    invitationType: InvitationType = "member",
  ): Promise<any> {
    const supabase = getSupabaseAdmin();
    const normalizedEmail = email.trim().toLowerCase();
    const nowIso = new Date().toISOString();

    const { data: existingUser } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    if (existingUser) {
      const { data: existingMember } = await supabase
        .from("user_companies")
        .select("id")
        .eq("user_id", existingUser.id)
        .eq("company_id", companyId)
        .maybeSingle();

      if (existingMember) {
        throw new ConflictException(
          "Cet utilisateur est déjà membre de cette entreprise",
        );
      }
    }

    await supabase
      .from("company_invitations")
      .delete()
      .eq("company_id", companyId)
      .ilike("email", normalizedEmail)
      .is("accepted_at", null)
      .lt("expires_at", nowIso);

    const { data: existingInvite } = await supabase
      .from("company_invitations")
      .select("id")
      .eq("company_id", companyId)
      .ilike("email", normalizedEmail)
      .is("accepted_at", null)
      .gt("expires_at", nowIso)
      .maybeSingle();

    if (existingInvite) {
      throw new ConflictException(
        "Une invitation est déjà en attente pour cet email",
      );
    }

    const { data: invitation, error } = await supabase
      .from("company_invitations")
      .insert({
        company_id: companyId,
        email: normalizedEmail,
        role,
        invited_by: userId,
        invitation_type: invitationType,
        billing_status: "settled",
      })
      .select()
      .single();

    if (error || !invitation) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException(
          "Une invitation est déjà en attente pour cet email",
        );
      }

      throw new BadRequestException(
        `Erreur lors de l'invitation: ${error?.message || "inconnue"}`,
      );
    }

    if (this.shouldSyncMemberQuantity(companyOwnerRole, role)) {
      try {
        const syncResult =
          await this.subscriptionService.syncMemberQuantity(companyId);
        if (syncResult?.client_secret) {
          const { error: billingStatusError } = await supabase
            .from("company_invitations")
            .update({ billing_status: "payment_required" })
            .eq("id", invitation.id);

          if (billingStatusError) {
            await this.rollbackPendingMemberInvitation(supabase, invitation.id);

            throw new BadRequestException(
              `Erreur lors du blocage de l'invitation en attente de paiement: ${billingStatusError.message}`,
            );
          }

          return {
            ...invitation,
            billing_status: "payment_required",
            status: "payment_required",
            client_secret: syncResult.client_secret,
          };
        }
      } catch (syncError) {
        await this.rollbackPendingMemberInvitation(supabase, invitation.id);

        throw new BadRequestException(
          this.getMemberBillingSyncErrorMessage(syncError),
        );
      }
    }

    return this.deliverMemberInvitation(
      userId,
      companyId,
      invitation,
      companyOwnerRole,
    );
  }

  private async deliverMemberInvitation(
    userId: string,
    companyId: string,
    invitation: any,
    _companyOwnerRole: CompanyOwnerRole,
  ): Promise<any> {
    const supabase = getSupabaseAdmin();
    const normalizedEmail = invitation.email.trim().toLowerCase();
    const role = invitation.role as CompanyRole;

    const { data: existingUser } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    if (existingUser) {
      const { data: existingMember } = await supabase
        .from("user_companies")
        .select("id")
        .eq("user_id", existingUser.id)
        .eq("company_id", companyId)
        .maybeSingle();

      if (existingMember) {
        throw new ConflictException(
          "Cet utilisateur est déjà membre de cette entreprise",
        );
      }

      const { error: memberInsertError } = await supabase
        .from("user_companies")
        .insert({
          user_id: existingUser.id,
          company_id: companyId,
          role,
          is_default: false,
        });

      if (memberInsertError) {
        throw new BadRequestException(
          `Erreur lors de l'ajout du membre: ${memberInsertError.message}`,
        );
      }

      const { error: invitationAcceptError } = await supabase
        .from("company_invitations")
        .update({ accepted_at: new Date().toISOString() })
        .eq("id", invitation.id);

      if (invitationAcceptError) {
        await supabase
          .from("user_companies")
          .delete()
          .eq("user_id", existingUser.id)
          .eq("company_id", companyId);

        throw new BadRequestException(
          `Erreur lors de la validation de l'invitation: ${invitationAcceptError.message}`,
        );
      }

      return { ...invitation, status: "accepted" };
    }

    await this.sendMemberInvitationEmail(
      userId,
      companyId,
      normalizedEmail,
      role,
      invitation.token,
    );

    return { ...invitation, status: "pending" };
  }

  private async sendMemberInvitationEmail(
    userId: string,
    companyId: string,
    email: string,
    role: CompanyRole,
    token: string,
  ): Promise<void> {
    const supabase = getSupabaseAdmin();
    const normalizedEmail = email.trim().toLowerCase();

    const { data: company } = await supabase
      .from("companies")
      .select(
        "name, email, phone, address, postal_code, city, siren, logo_url",
      )
      .eq("id", companyId)
      .single();

    const { data: inviter } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", userId)
      .single();

    const inviterName =
      [inviter?.first_name, inviter?.last_name].filter(Boolean).join(" ") ||
      "Un administrateur";

    try {
      await this.notificationService.sendInviteEmail(
        normalizedEmail,
        inviterName,
        company,
        role,
        token,
      );
    } catch {
      // Ne pas échouer si l'envoi email échoue
    }
  }

  private async createMerchantSignupInvitation(
    userId: string,
    accountantCompanyId: string,
    email: string,
    draft: MerchantSignupDraft,
  ): Promise<{ id: string; token: string; email: string; role: CompanyRole }> {
    const supabase = getSupabaseAdmin();
    const normalizedEmail = email.trim().toLowerCase();

    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    if (existingProfile) {
      throw new ConflictException(
        "Cette adresse email possède déjà un compte SENED. Utilisez une autre adresse pour inviter un nouveau marchand.",
      );
    }

    const { data: existingInvite } = await supabase
      .from("company_invitations")
      .select("id")
      .eq("company_id", accountantCompanyId)
      .ilike("email", normalizedEmail)
      .is("accepted_at", null)
      .maybeSingle();

    if (existingInvite) {
      throw new ConflictException(
        "Une invitation est déjà en attente pour cet email",
      );
    }

    const { data: invitation, error } = await supabase
      .from("company_invitations")
      .insert({
        company_id: accountantCompanyId,
        email: normalizedEmail,
        role: "merchant_admin",
        invited_by: userId,
        invitation_type: "merchant_signup",
        signup_company_name: draft.company_name,
        signup_siren: draft.siren,
        signup_siret: draft.siret || null,
        signup_address: draft.address || null,
        signup_postal_code: draft.postal_code || null,
        signup_city: draft.city || null,
        signup_country: draft.country || "FR",
      })
      .select("id, token, email, role")
      .single();

    if (error || !invitation) {
      throw new BadRequestException(
        `Erreur lors de l'invitation: ${error?.message || "inconnue"}`,
      );
    }

    const { data: company } = await supabase
      .from("companies")
      .select("name, email, phone, address, postal_code, city, siren, logo_url")
      .eq("id", accountantCompanyId)
      .single();

    const { data: inviter } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", userId)
      .single();

    const inviterName =
      [inviter?.first_name, inviter?.last_name].filter(Boolean).join(" ") ||
      "Un administrateur";

    try {
      await this.notificationService.sendInviteEmail(
        normalizedEmail,
        inviterName,
        company,
        "merchant_admin",
        invitation.token,
      );
    } catch {
      // Ne pas échouer si l'envoi email échoue
    }

    return {
      id: invitation.id,
      token: invitation.token,
      email: invitation.email,
      role: invitation.role as CompanyRole,
    };
  }

  private async cancelCompanyInvitation(
    companyId: string,
    invitationId: string,
    companyOwnerRole: CompanyOwnerRole,
    allowedRoles?: CompanyRole[],
    allowedInvitationTypes?: InvitationType[],
  ): Promise<{ message: string }> {
    const supabase = getSupabaseAdmin();

    const { data: invitationToCancel, error: invitationError } = await supabase
      .from("company_invitations")
      .select(
        "id, company_id, email, role, token, invited_by, expires_at, invitation_type, signup_company_name, signup_siren, signup_siret, signup_address, signup_postal_code, signup_city, signup_country",
      )
      .eq("id", invitationId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (invitationError) {
      throw new BadRequestException(`Erreur: ${invitationError.message}`);
    }

    if (!invitationToCancel) {
      throw new NotFoundException("Invitation introuvable");
    }

    if (
      allowedRoles &&
      !allowedRoles.includes(invitationToCancel.role as CompanyRole)
    ) {
      throw new NotFoundException("Invitation introuvable");
    }

    if (
      allowedInvitationTypes &&
      !allowedInvitationTypes.includes(
        ((invitationToCancel as any).invitation_type || "member") as InvitationType,
      )
    ) {
      throw new NotFoundException("Invitation introuvable");
    }

    const { error } = await supabase
      .from("company_invitations")
      .delete()
      .eq("id", invitationId)
      .eq("company_id", companyId);

    if (error) {
      throw new BadRequestException(`Erreur: ${error.message}`);
    }

    if (
      this.shouldSyncMemberQuantity(
        companyOwnerRole,
        invitationToCancel.role as CompanyRole,
      )
    ) {
      try {
        await this.subscriptionService.syncMemberQuantity(companyId);
      } catch (syncError) {
        await supabase.from("company_invitations").insert({
          id: invitationToCancel.id,
          company_id: invitationToCancel.company_id,
          email: invitationToCancel.email,
          role: invitationToCancel.role,
          token: invitationToCancel.token,
          invited_by: invitationToCancel.invited_by,
          expires_at: invitationToCancel.expires_at,
          invitation_type: invitationToCancel.invitation_type || "member",
          signup_company_name:
            (invitationToCancel as any).signup_company_name || null,
          signup_siren: (invitationToCancel as any).signup_siren || null,
          signup_siret: (invitationToCancel as any).signup_siret || null,
          signup_address: (invitationToCancel as any).signup_address || null,
          signup_postal_code:
            (invitationToCancel as any).signup_postal_code || null,
          signup_city: (invitationToCancel as any).signup_city || null,
          signup_country: (invitationToCancel as any).signup_country || null,
        });

        throw new BadRequestException(
          this.getMemberBillingSyncErrorMessage(syncError),
        );
      }
    }

    return { message: "Invitation annulée" };
  }

  private async rollbackPendingMemberInvitation(
    supabase: any,
    invitationId: string,
  ): Promise<void> {
    await supabase.from("company_invitations").delete().eq("id", invitationId);
  }

  private async rollbackAcceptedMemberInvitation(
    supabase: any,
    companyId: string,
    invitationId: string,
    memberUserId: string,
  ): Promise<void> {
    await supabase
      .from("user_companies")
      .delete()
      .eq("user_id", memberUserId)
      .eq("company_id", companyId);

    await this.rollbackPendingMemberInvitation(supabase, invitationId);
  }

  private isUniqueConstraintError(error: any): boolean {
    return (
      error?.code === "23505" ||
      /duplicate key|unique constraint|constraint/i.test(error?.message || "")
    );
  }

  private extractErrorMessage(error: unknown): string | null {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === "string") {
        return response;
      }

      if (response && typeof response === "object" && "message" in response) {
        const message = (response as { message?: string | string[] }).message;
        return Array.isArray(message) ? message.join(", ") : message || null;
      }
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return null;
  }

  private getMemberBillingSyncErrorMessage(error: unknown): string {
    const rawMessage = this.extractErrorMessage(error);
    if (!rawMessage) {
      return "L'ajout du membre n'a pas pu être finalisé car la mise à jour de la facturation a échoué.";
    }

    if (
      rawMessage.includes("payment_behavior") ||
      rawMessage.includes("pending_if_incomplete") ||
      rawMessage.includes("sepa_debit")
    ) {
      return "L'ajout du membre n'a pas pu être finalisé car le moyen de paiement actuel de l'abonnement ne permet pas de facturer immédiatement ce supplément.";
    }

    if (
      rawMessage.toLowerCase().includes("stripe") ||
      rawMessage.toLowerCase().includes("payment")
    ) {
      return "L'ajout du membre n'a pas pu être finalisé car la mise à jour de la facturation a échoué.";
    }

    return rawMessage;
  }

  private shouldSyncMemberQuantity(
    companyOwnerRole: CompanyOwnerRole,
    invitedRole?: CompanyRole,
  ): boolean {
    return (
      companyOwnerRole === "merchant_admin" &&
      (invitedRole === undefined ||
        invitedRole === "merchant_admin" ||
        invitedRole === "merchant_consultant")
    );
  }
}
