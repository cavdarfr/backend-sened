import {
  IsArray,
  IsString,
  IsOptional,
  IsEmail,
  IsUrl,
  IsNumber,
  IsBoolean,
  IsIn,
  IsUUID,
  MinLength,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
  Matches,
  ValidateIf,
} from "class-validator";
import { Transform } from "class-transformer";

/**
 * DTO pour la création d'une entreprise
 */
export class CreateCompanyDto {
  @IsString()
  @MinLength(2, { message: "Le nom doit contenir au moins 2 caractères" })
  @MaxLength(255, { message: "Le nom ne peut pas dépasser 255 caractères" })
  name: string;

  @IsOptional()
  @IsIn(["merchant_admin", "accountant"])
  owner_role?: "merchant_admin" | "accountant";

  @IsOptional()
  @IsUUID("4")
  source_accountant_company_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legal_name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{9}$/, {
    message: "Le SIREN doit contenir exactement 9 chiffres",
  })
  siren?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  vat_number?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Transform(({ value }) => value?.toUpperCase())
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @ValidateIf((o) => o.email && o.email.length > 0)
  @IsEmail({}, { message: "Email invalide" })
  email?: string;

  @IsOptional()
  @ValidateIf((o) => o.website && o.website.length > 0)
  @IsUrl({}, { message: "URL de site web invalide" })
  website?: string;

  @IsOptional()
  @ValidateIf((o) => o.logo_url && o.logo_url.length > 0)
  @IsUrl({}, { message: "URL du logo invalide" })
  logo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  rib_iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(11)
  rib_bic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  rib_bank_name?: string;

  @IsOptional()
  @IsBoolean()
  is_vat_exempt?: boolean;

  @IsOptional()
  @IsString()
  vat_exemption_note?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  default_vat_rate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(365)
  default_payment_terms?: number;

  @IsOptional()
  @IsString()
  terms_and_conditions?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  quote_validity_days?: number;

  @IsOptional()
  @IsString()
  quote_footer?: string;

  @IsOptional()
  @IsString()
  invoice_footer?: string;
}

/**
 * DTO pour la mise à jour d'une entreprise
 * Tous les champs sont optionnels
 */
export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: "Le nom doit contenir au moins 2 caractères" })
  @MaxLength(255, { message: "Le nom ne peut pas dépasser 255 caractères" })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legal_name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{9}$/, {
    message: "Le SIREN doit contenir exactement 9 chiffres",
  })
  siren?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  vat_number?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Transform(({ value }) => value?.toUpperCase())
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @ValidateIf((o) => o.email && o.email.length > 0)
  @IsEmail({}, { message: "Email invalide" })
  email?: string;

  @IsOptional()
  @ValidateIf((o) => o.website && o.website.length > 0)
  @IsUrl({}, { message: "URL de site web invalide" })
  website?: string;

  @IsOptional()
  @ValidateIf((o) => o.logo_url && o.logo_url.length > 0)
  @IsUrl({}, { message: "URL du logo invalide" })
  logo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  rib_iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(11)
  rib_bic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  rib_bank_name?: string;

  @IsOptional()
  @IsBoolean()
  is_vat_exempt?: boolean;

  @IsOptional()
  @IsString()
  vat_exemption_note?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  default_vat_rate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(365)
  default_payment_terms?: number;

  @IsOptional()
  @IsString()
  terms_and_conditions?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  quote_validity_days?: number;

  @IsOptional()
  @IsString()
  quote_footer?: string;

  @IsOptional()
  @IsString()
  invoice_footer?: string;
}

/**
 * DTO de réponse pour une entreprise
 */
export class CompanyResponseDto {
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
  created_at: string;
  updated_at: string;
  is_owner: boolean;
  company_owner_role: "merchant_admin" | "accountant";
  accountant_company_id: string | null;
  accountant_firm_summary: AccountantFirmSummaryDto | null;
  accountant_link_status: "none" | "linked" | "invite_pending";
}

export class AccountantLinkRequestCompanySummaryDto {
  id: string;
  name: string;
  legal_name: string | null;
  siren: string | null;
  email: string | null;
  city: string | null;
  logo_url: string | null;
}

export class AccountantLinkRequestResponseDto {
  id: string;
  accountant_company_id: string;
  merchant_company_id: string;
  request_origin: "existing_merchant" | "new_client_invitation";
  requested_by: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  created_at: string;
  responded_at: string | null;
  responded_by: string | null;
  accountant_company: AccountantLinkRequestCompanySummaryDto;
  merchant_company: AccountantLinkRequestCompanySummaryDto;
}

/**
 * DTO résumé du cabinet comptable lié
 */
export class AccountantFirmSummaryDto {
  id: string;
  name: string;
  legal_name: string | null;
  siren: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
}

/**
 * DTO de réponse pour une entreprise avec le rôle de l'utilisateur
 */
export class CompanyWithRoleResponseDto extends CompanyResponseDto {
  role:
    | "merchant_admin"
    | "merchant_consultant"
    | "accountant"
    | "accountant_consultant"
    | "superadmin";
  is_default: boolean;
}

/**
 * DTO pour la liste des entreprises
 */
export class CompanyListResponseDto {
  companies: CompanyWithRoleResponseDto[];
  total: number;
  owned_total: number;
}

/**
 * DTO pour les paramètres de recherche/filtrage
 */
export class CompanyQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10))
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number = 10;
}

export type AccountantDocumentTypeDto = "invoices" | "credit-notes";
export type AccountantDocumentPeriodDto =
  | "year"
  | "q1"
  | "q2"
  | "q3"
  | "q4"
  | "m01"
  | "m02"
  | "m03"
  | "m04"
  | "m05"
  | "m06"
  | "m07"
  | "m08"
  | "m09"
  | "m10"
  | "m11"
  | "m12";
export type AccountantDocumentStatusDto =
  | "sent"
  | "paid"
  | "overdue"
  | "cancelled";

const accountantDocumentTypes = ["invoices", "credit-notes"] as const;
const accountantDocumentPeriods = [
  "year",
  "q1",
  "q2",
  "q3",
  "q4",
  "m01",
  "m02",
  "m03",
  "m04",
  "m05",
  "m06",
  "m07",
  "m08",
  "m09",
  "m10",
  "m11",
  "m12",
] as const;
const accountantDocumentStatuses = [
  "sent",
  "paid",
  "overdue",
  "cancelled",
] as const;

export class AccountantDocumentsQueryDto {
  @IsOptional()
  @IsIn(accountantDocumentTypes)
  type?: AccountantDocumentTypeDto = "invoices";

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10))
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number = 20;

  @IsOptional()
  @IsNumber()
  @Min(2000)
  @Max(2100)
  @Transform(({ value }) => parseInt(value, 10))
  year?: number;

  @IsOptional()
  @IsIn(accountantDocumentPeriods)
  period?: AccountantDocumentPeriodDto;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(accountantDocumentStatuses, { each: true })
  statuses?: AccountantDocumentStatusDto[];
}

export class BulkDownloadLinkedClientDocumentsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("4", {
    each: true,
    message: "Chaque document_id doit être un UUID valide",
  })
  document_ids?: string[];

  @IsIn(accountantDocumentTypes)
  type: AccountantDocumentTypeDto;

  @IsOptional()
  @IsNumber()
  @Min(2000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsIn(accountantDocumentPeriods)
  period?: AccountantDocumentPeriodDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(accountantDocumentStatuses, { each: true })
  statuses?: AccountantDocumentStatusDto[];
}

/**
 * DTO pour définir une entreprise par défaut
 */
export class SetDefaultCompanyDto {
  @IsUUID("4", { message: "ID d'entreprise invalide" })
  company_id: string;
}

// ============================================
// DTOs pour mise à jour par section
// ============================================

/**
 * DTO pour la mise à jour des informations générales
 * Section: Général
 */
export class UpdateCompanyGeneralDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: "Le nom doit contenir au moins 2 caractères" })
  @MaxLength(255, { message: "Le nom ne peut pas dépasser 255 caractères" })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legal_name?: string;

  @IsOptional()
  @ValidateIf((o) => o.siren && o.siren.length > 0)
  @IsString()
  @Matches(/^[0-9]{9}$/, {
    message: "Le SIREN doit contenir exactement 9 chiffres",
  })
  siren?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  vat_number?: string;

  @IsOptional()
  @ValidateIf((o) => o.logo_url && o.logo_url.length > 0)
  @IsUrl({}, { message: "URL du logo invalide" })
  logo_url?: string;
}

/**
 * DTO pour la mise à jour des coordonnées
 * Section: Contact
 */
export class UpdateCompanyContactDto {
  @IsOptional()
  @ValidateIf((o) => o.email && o.email.length > 0)
  @IsEmail({}, { message: "Email invalide" })
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @ValidateIf((o) => o.website && o.website.length > 0)
  @IsUrl({}, { message: "URL de site web invalide" })
  website?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Transform(({ value }) => value?.toUpperCase())
  country?: string;
}

/**
 * DTO pour la mise à jour des informations bancaires
 * Section: Bancaire
 */
export class UpdateCompanyBankingDto {
  @IsOptional()
  @IsString()
  @MaxLength(34)
  rib_iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(11)
  rib_bic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  rib_bank_name?: string;
}

export class UpdateMemberRoleDto {
  @IsIn([
    "merchant_admin",
    "merchant_consultant",
    "accountant",
    "accountant_consultant",
  ])
  role:
    | "merchant_admin"
    | "merchant_consultant"
    | "accountant"
    | "accountant_consultant";
}

/**
 * DTO pour lier un expert-comptable
 */
export class LinkAccountantDto {
  @IsUUID("4", { message: "ID d'entreprise comptable invalide" })
  accountant_company_id: string;
}

export class CreateAccountantLinkRequestDto {
  @IsUUID("4", { message: "ID d'entreprise commerçante invalide" })
  merchant_company_id: string;
}

export class AccountantLinkRequestsQueryDto {
  @IsOptional()
  @IsIn(["incoming", "outgoing"])
  direction?: "incoming" | "outgoing" = "incoming";
}

/**
 * DTO pour inviter un membre
 */
export class InviteMemberDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: "Email invalide" })
  email: string;

  @IsString()
  role:
    | "merchant_admin"
    | "merchant_consultant"
    | "accountant"
    | "accountant_consultant"
    | "superadmin";
}

export class InviteLinkedClientMerchantAdminDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: "Email invalide" })
  email: string;
}

export class InviteNewMerchantAdminDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: "Email invalide" })
  email: string;

  @IsString()
  @MinLength(2, {
    message: "Le nom de l'entreprise doit contenir au moins 2 caractères",
  })
  @MaxLength(255, {
    message: "Le nom de l'entreprise ne peut pas dépasser 255 caractères",
  })
  company_name: string;

  @Transform(({ value }) =>
    typeof value === "string" ? value.replace(/\D/g, "") : value,
  )
  @Matches(/^[0-9]{9}$/, {
    message: "Le SIREN doit contenir exactement 9 chiffres",
  })
  siren: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.replace(/\D/g, "") : value,
  )
  @Matches(/^[0-9]{14}$/, {
    message: "Le SIRET doit contenir exactement 14 chiffres",
  })
  siret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Transform(({ value }) => value?.toUpperCase())
  country?: string;
}

/**
 * DTO pour inviter un cabinet comptable (si absent de la plateforme)
 */
export class InviteAccountantFirmDto {
  @IsString()
  @MinLength(2, {
    message: "Le nom du cabinet doit contenir au moins 2 caractères",
  })
  @MaxLength(255, {
    message: "Le nom du cabinet ne peut pas dépasser 255 caractères",
  })
  firm_name: string;

  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: "Email invalide" })
  email: string;

  @Transform(({ value }) =>
    typeof value === "string" ? value.replace(/\s/g, "") : value,
  )
  @Matches(/^[0-9]{9}$/, {
    message: "Le SIREN doit contenir exactement 9 chiffres",
  })
  siren: string;
}

/**
 * DTO pour la mise à jour des paramètres
 * Section: Paramètres
 */
export class UpdateCompanySettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  default_vat_rate?: number;

  @IsOptional()
  @IsBoolean()
  is_vat_exempt?: boolean;

  @IsOptional()
  @IsString()
  vat_exemption_note?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(365)
  default_payment_terms?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  quote_validity_days?: number;

  @IsOptional()
  @IsString()
  terms_and_conditions?: string;

  @IsOptional()
  @IsString()
  quote_footer?: string;

  @IsOptional()
  @IsString()
  invoice_footer?: string;
}
