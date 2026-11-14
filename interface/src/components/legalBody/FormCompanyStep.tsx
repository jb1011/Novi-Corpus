"use client";

import { useMemo, useState } from "react";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  emptyParty,
  isPartyValid,
  toFormationPartyInput,
  validateParty,
  type FormationParty,
} from "@/components/onboarding/types";
import { CompanyIntakeFields } from "@/components/onboarding/steps/CompanyIntakeFields";
import { PartyFields } from "@/components/onboarding/steps/PartyFields";
import {
  AmberPill,
  Button,
  Callout,
  Card,
  StepHeader,
} from "@/components/onboarding/primitives";
import {
  useCreateCompanyMutation,
  useCreateFormationPartyMutation,
  useFormationRulesQuery,
  usePublicConfigQuery,
  useWorldIdMeQuery,
} from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/types";
import { formationCopyOf } from "@/lib/formation/copy";
import {
  emptyCompanyIntake,
  industryIndex,
  intakeRulesOf,
  isCompanyIntakeValid,
  validateCompanyIntake,
  type CompanyIntakeForm,
} from "@/lib/formation/companyIntake";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const C = LEGAL_BODY_COPY.company.formed;

/**
 * The formed door's company step. Production names are read from the identity record and are not
 * sent. Sandbox sends a synthetic party and collects no name and no tax number. The marketing box
 * is production only: testnet does not store the consent.
 */
export function FormCompanyStep({ kit }: { kit: LegalBodyStepKit }) {
  const production = kit.config.environment === "production";
  const me = useWorldIdMeQuery();
  const identity = me.data?.identity;
  const names =
    identity?.state === "verified" && identity.firstName && identity.lastName
      ? { first: identity.firstName, last: identity.lastName }
      : null;
  const configQuery = usePublicConfigQuery();
  const rulesQuery = useFormationRulesQuery();
  const createParty = useCreateFormationPartyMutation();
  const createCompany = useCreateCompanyMutation();
  const [party, setParty] = useState<FormationParty>(emptyParty);
  const [intake, setIntake] = useState<CompanyIntakeForm>(emptyCompanyIntake);
  const [ssn, setSsn] = useState("");
  const [marketing, setMarketing] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const rules = intakeRulesOf(rulesQuery.data);
  const industries = useMemo(
    () => industryIndex(rulesQuery.data?.industries),
    [rulesQuery.data?.industries],
  );
  const partyErrors = validateParty(party, { names: !production });
  const intakeErrors = validateCompanyIntake(intake, rules, industries.known);
  const copy = formationCopyOf(configQuery.data);
  const busy = createParty.isPending || createCompany.isPending;
  const usa = party.country.trim().toUpperCase() === "USA";
  const fee = configQuery.data?.formationFeeUsdc;

  function setPartyField<K extends keyof FormationParty>(key: K, value: FormationParty[K]) {
    setParty((current) => ({ ...current, [key]: value }));
  }

  async function create() {
    if (busy) return;
    setShowErrors(true);
    setSaid(null);
    if (!isCompanyIntakeValid(intake, rules, industries.known)) return;
    if (production && !names) {
      setSaid(C.identity);
      return;
    }
    if (production && !isPartyValid(party, { names: false })) return;
    try {
      const { partyId } = await createParty.mutateAsync(
        production
          ? toFormationPartyInput(party, {
              omitNames: true,
              marketingConsent: marketing,
            })
          : { synthetic: true },
      );
      const { companyId } = await createCompany.mutateAsync({
        partyId,
        names: intake.names.map((name) => name.trim()),
        businessPurpose: intake.businessPurpose.trim(),
        industryLabel: intake.industryLabel,
        for: "legal_body",
        ...(production && usa && ssn.trim() ? { ssn: ssn.trim() } : {}),
        ...(!production ? { synthetic: true as const } : {}),
      });
      setSsn("");
      kit.remember({ companyId, orderId: null });
    } catch (e) {
      setSaid(sentenceOf(e));
    }
  }

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.company}
        title={C.title}
        intro={production ? C.intro : C.sandboxIntro}
      />
      {!production && (
        <div className="mb-5">
          <AmberPill size="label">{LEGAL_BODY_COPY.company.testLabel}</AmberPill>
        </div>
      )}
      <Card className="p-6">
        <CompanyIntakeFields
          form={intake}
          errors={intakeErrors}
          showErrors={showErrors}
          industries={industries}
          loading={rulesQuery.isPending}
          idPrefix="formed-company"
          onChange={setIntake}
        />
      </Card>
      {production && (
        <div className="mt-6">
          <PartyFields
            party={party}
            errors={showErrors ? partyErrors : {}}
            set={setPartyField}
            readOnlyNames={names ?? undefined}
            namesNote={C.namesNote}
            ssn={usa ? ssn : undefined}
            onSsn={setSsn}
            ssnCopy={copy.ssn}
          />
          {!usa && party.country.trim() !== "" && (
            <p className="mt-3 text-[12.5px] leading-[1.6] text-muted">{C.nonUs}</p>
          )}
          <label className="mt-5 flex cursor-pointer items-start gap-3 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            <span className="text-muted">{C.marketing}</span>
          </label>
        </div>
      )}
      {production && typeof fee === "number" && kit.config.paymentRequired && (
        <p className="mt-4 text-[12.5px] leading-[1.6] text-muted">
          {fillCopy(C.fee, { fee: String(fee) })}
        </p>
      )}
      {said && (
        <Callout tone="warn" className="mt-6">
          {said}
        </Callout>
      )}
      <StepNav>
        <Button onClick={() => void create()} loading={busy} disabled={production && !names}>
          {C.create}
        </Button>
      </StepNav>
    </div>
  );
}

function sentenceOf(e: unknown): string {
  if (!(e instanceof ApiError)) return "Could not create the company.";
  if (e.code === "formation_cap_reached") return C.cap;
  if (e.code === "guardian_identity_not_verified") return C.identity;
  if (e.code === "legal_text_not_approved") return C.texts;
  return e.message;
}
