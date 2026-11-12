"use client";

import { useState } from "react";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card, Field, StepHeader, TextInput } from "@/components/onboarding/primitives";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { entranceMemory, type EntranceOffer } from "@/lib/legalBody/entrance";
import type { DoorChoice, IdentityChoice, LegalBodyMemory, OwnerChoice } from "@/lib/legalBody/storage";

const E = LEGAL_BODY_COPY.entrance;

/**
 * The three questions in front of a new company. The answers are a memory patch. They file nothing.
 */
export function EntranceStep({
  offer,
  onAnswer,
}: {
  offer: Extract<EntranceOffer, { kind: "ask" }>;
  onAnswer: (
    patch: Pick<LegalBodyMemory, "door" | "identityChoice" | "signer" | "suggestedAgentId">,
  ) => void;
}) {
  const [door, setDoor] = useState<DoorChoice>(offer.canForm ? "form" : "declare");
  const [identityChoice, setIdentityChoice] = useState<IdentityChoice>("not-yet");
  const [signer, setSigner] = useState<OwnerChoice>("this-wallet");
  const [agentId, setAgentId] = useState("");

  return (
    <div>
      <StepHeader eyebrow={E.title} title={E.title} intro={E.intro} />
      <Card className="p-6">
        <fieldset className="flex flex-col gap-3">
          <legend className="text-[13px] text-ink">{E.company}</legend>
          <Choice
            name="door"
            checked={door === "declare"}
            label={E.have}
            onChange={() => setDoor("declare")}
          />
          {offer.canForm && (
            <Choice
              name="door"
              checked={door === "form"}
              label={E.form}
              onChange={() => setDoor("form")}
            />
          )}
        </fieldset>
        {offer.capReached && (
          <Callout tone="warn" className="mt-4">
            {E.capReached}
          </Callout>
        )}

        <fieldset className="mt-6 flex flex-col gap-3">
          <legend className="text-[13px] text-ink">{E.identity}</legend>
          <Choice
            name="identity"
            checked={identityChoice === "has-one"}
            label={E.hasOne}
            onChange={() => setIdentityChoice("has-one")}
          />
          {identityChoice === "has-one" && (
            <Field label={E.agentId} htmlFor="entrance-agent">
              <TextInput
                id="entrance-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
              />
            </Field>
          )}
          <Choice
            name="identity"
            checked={identityChoice === "not-yet"}
            label={E.notYet}
            onChange={() => setIdentityChoice("not-yet")}
          />
        </fieldset>

        <fieldset className="mt-6 flex flex-col gap-3">
          <legend className="text-[13px] text-ink">{E.key}</legend>
          <Choice
            name="signer"
            checked={signer === "this-wallet"}
            label={E.thisWallet}
            onChange={() => setSigner("this-wallet")}
          />
          <Choice
            name="signer"
            checked={signer === "elsewhere"}
            label={E.anotherKey}
            onChange={() => setSigner("elsewhere")}
          />
          <p className="text-[12.5px] leading-[1.6] text-muted">{E.keySentence}</p>
        </fieldset>
      </Card>
      <StepNav>
        <Button
          onClick={() =>
            onAnswer(entranceMemory({ door, identityChoice, signer, agentId }, offer))
          }
        >
          {E.continue}
        </Button>
      </StepNav>
    </div>
  );
}

function Choice({
  name,
  checked,
  label,
  onChange,
}: {
  name: string;
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-[13px] text-ink">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
      />
      <span>{label}</span>
    </label>
  );
}
