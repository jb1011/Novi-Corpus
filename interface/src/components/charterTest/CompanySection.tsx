"use client";

import { useState } from "react";
import { useConnection, useSignTypedData } from "wagmi";
import { Button, Field, TextInput } from "@/components/onboarding/primitives";
import { useCompaniesQuery } from "@/lib/api/hooks";
import {
  useAbandonCompanyMutation,
  useCreateCustomerCompanyMutation,
  useStatementMessageMutation,
} from "@/lib/api/legalBodyHooks";
import type { Address, CustomerStatementInput, StatementMessageAnswer } from "@/lib/api/types";
import { isDeclaredCompany, wordingAcceptedShown } from "@/lib/charterTest/company";
import type { CharterTestConfig } from "@/lib/charterTest/served";
import { declarationInput } from "@/lib/legalBody/declaration";
import { sameAddress } from "@/lib/legalBody/flow";
import { signThroughGate, statementSignGate } from "@/lib/legalBody/signGate";
import { Facts, Line, Refusal, Section, Served } from "./parts";

/**
 * The company: the tenant's declared companies, and the declaration of a test company.
 *
 * The declaration takes two clicks, so that what the server serves is read before anything is
 * signed. The first asks for the statement and shows it: the rule of the adoption first
 * (`adoptionRule`, served beside the statement and not part of it), then the sentence the wallet
 * will sign. The second signs that statement and creates the company. The statement is checked
 * field by field by the product's own gate before it is shown and again before the wallet opens,
 * and the wallet opens for a statement the gate accepted only.
 *
 * The form is not checked here: what is typed is sent, normalised as the door normalises it, and
 * the server's refusal is shown as served. A sandbox names its own declarant, so two fields are
 * typed.
 */
export function CompanySection({
  config,
  tenant,
  companyId,
  onSelect,
}: {
  config: CharterTestConfig;
  tenant: Address;
  companyId: string | null;
  onSelect: (companyId: string) => void;
}) {
  const companiesQuery = useCompaniesQuery();
  const abandon = useAbandonCompanyMutation();
  const declared = (companiesQuery.data?.companies ?? []).filter(isDeclaredCompany);

  return (
    <Section title="3. Company">
      <h3 className="text-[13px] font-medium text-ink">Your declared companies (GET /companies)</h3>
      <Refusal error={companiesQuery.error} />
      {companiesQuery.data !== undefined && declared.length === 0 && <Line>None.</Line>}
      {declared.map((company) => (
        <div key={company.companyId} className="flex flex-col gap-2 rounded-xl border hairline px-4 py-3">
          <Facts
            rows={[
              ["companyId", company.companyId],
              ["declared.companyName", company.declared?.companyName],
              ["declared.filingNumber", company.declared?.filingNumber],
              ["declared.wordingVersion", company.declared?.wordingVersion],
              ["declared.wordingAccepted", wordingAcceptedShown(company)],
              ["state", company.state],
              ["verification.state", company.verification?.state],
            ]}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="ghost"
              disabled={company.companyId === companyId}
              onClick={() => onSelect(company.companyId)}
            >
              {company.companyId === companyId ? "Selected" : "Use this company"}
            </Button>
            <Button
              variant="subtle"
              loading={abandon.isPending && abandon.variables === company.companyId}
              onClick={() => abandon.mutate(company.companyId)}
            >
              Abandon (POST /companies/:id/abandon)
            </Button>
          </div>
        </div>
      ))}
      <Refusal error={abandon.error} />
      <div>
        <Button variant="ghost" onClick={() => void companiesQuery.refetch()}>
          Read again
        </Button>
      </div>

      <h3 className="text-[13px] font-medium text-ink">Declare a test company</h3>
      <Declaration config={config} tenant={tenant} onCreated={onSelect} />
    </Section>
  );
}

function Declaration({
  config,
  tenant,
  onCreated,
}: {
  config: CharterTestConfig;
  tenant: Address;
  onCreated: (companyId: string) => void;
}) {
  const [companyName, setCompanyName] = useState("");
  const [filingNumber, setFilingNumber] = useState("");
  // The statement on screen, with the request it was served for: one the gate accepted.
  const [shown, setShown] = useState<{
    input: CustomerStatementInput;
    served: StatementMessageAnswer;
  } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const statementMessage = useStatementMessageMutation();
  const createCompany = useCreateCustomerCompanyMutation();
  const { signTypedDataAsync } = useSignTypedData();
  const { address: connected } = useConnection();

  /** A change of the form: the statement on screen was for the form as it was. */
  function edited() {
    setShown(null);
    setSaid(null);
    setCreated(null);
    statementMessage.reset();
    createCompany.reset();
  }

  const gateFor = (input: CustomerStatementInput, served: StatementMessageAnswer) =>
    statementSignGate(served, {
      config: { chainId: config.chainId, factory: config.factory },
      sessionAddress: tenant,
      typed: input,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

  /** The first click: the statement, checked, then shown. Writes nothing. */
  async function getStatement() {
    if (busy) return;
    setBusy(true);
    edited();
    try {
      const input = declarationInput(
        { companyName, filingNumber, declarantName: "", declarantTitle: "" },
        "sandbox",
      );
      const served = await statementMessage.mutateAsync(input);
      const gate = gateFor(input, served);
      if (!gate.ok) {
        setSaid(`The served statement did not pass this page's check, and is not shown: ${gate.problem}.`);
        return;
      }
      setShown({ input, served });
    } catch {
      // The refusal is the mutation's error, shown below as served.
    } finally {
      setBusy(false);
    }
  }

  /** The second click: the statement on screen, checked again, signed, and sent. */
  async function signAndCreate() {
    if (busy || shown === null) return;
    setSaid(null);
    createCompany.reset();
    if (!sameAddress(connected, tenant)) {
      setSaid("The connected wallet is not the wallet signed in: sign in again with this wallet.");
      return;
    }
    setBusy(true);
    try {
      // Checked again with the clock of this click: a statement is signed inside its window.
      const signed = await signThroughGate(gateFor(shown.input, shown.served), (typedData) =>
        signTypedDataAsync(typedData),
      );
      if (signed.kind === "refused") {
        setShown(null);
        setSaid(`The statement no longer passes this page's check, and the wallet was not opened: ${signed.problem}. Get the statement again.`);
        return;
      }
      if (signed.kind === "declined") {
        setSaid("The wallet did not sign.");
        return;
      }
      const { companyId } = await createCompany.mutateAsync({
        ...shown.input,
        issuedAt: shown.served.typedData.message.issuedAt,
        signature: signed.signature,
      });
      setShown(null);
      setCreated(companyId);
      onCreated(companyId);
    } catch {
      // The refusal is the mutation's error, shown below as served.
    } finally {
      setBusy(false);
    }
  }

  const message = shown?.served.typedData.message;
  // Read as untrusted: a key not served is told from a served null, and only text or null is
  // shown as served words.
  const rule: unknown =
    shown === null ? undefined : (shown.served as Record<string, unknown>).adoptionRule;

  return (
    <div className="flex flex-col gap-4">
      <Line>
        On a sandbox the name must contain the word test, and the number is TEST- then 4 to 27 of
        A-Z, 0-9 and hyphens. Nothing is checked here: the server checks both.
      </Line>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="companyName" htmlFor="charter-test-company-name">
          <TextInput
            id="charter-test-company-name"
            value={companyName}
            onChange={(e) => {
              setCompanyName(e.target.value);
              edited();
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </Field>
        <Field label="filingNumber" htmlFor="charter-test-filing-number">
          <TextInput
            id="charter-test-filing-number"
            value={filingNumber}
            onChange={(e) => {
              setFilingNumber(e.target.value);
              edited();
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </Field>
      </div>
      <div>
        <Button onClick={() => void getStatement()} loading={busy && shown === null}>
          Get the statement (POST /companies/customer/statement-message)
        </Button>
      </div>
      <Refusal error={statementMessage.error} />

      {shown !== null && message !== undefined && (
        <>
          {typeof rule === "string" || rule === null ? (
            <Served
              name="adoptionRule (served beside the statement; not part of what is signed)"
              text={rule}
            />
          ) : (
            <Facts
              rows={[
                ["adoptionRule", Object.hasOwn(shown.served, "adoptionRule") ? rule : "not served"],
              ]}
            />
          )}
          <Served name="statement (the sentence the wallet will sign)" text={message.statement} />
          <Facts
            rows={[
              ["wordingVersion", shown.served.wordingVersion],
              ["textStatus", shown.served.textStatus],
              ["declarantName", message.declarantName],
              ["declarantTitle", message.declarantTitle],
              ["guardian", message.guardian],
              ["issuedAt", message.issuedAt],
            ]}
          />
          <div>
            <Button onClick={() => void signAndCreate()} loading={busy}>
              Sign the declaration and create the company (POST /companies/customer)
            </Button>
          </div>
        </>
      )}
      {said && <Line>{said}</Line>}
      <Refusal error={createCompany.error} />
      {created && <Facts rows={[["created companyId", created]]} />}
    </div>
  );
}
