import type { CheckReasonCode } from "@/lib/api/types";

/**
 * Every sentence the legal-body flow shows, in one place, grouped by screen.
 *
 * A screen takes its words from here and never writes its own, so one test walks them all against
 * the claims ceiling: "a registered legal body", and never a word that claims more than the facts
 * behind it; no em dash; "verified" said only of the person (`PERSON_SENTENCES`); "Novi Corpus"
 * everywhere, and "Novi" alone only in the one approved sentence (`APPROVED_NOVI_SENTENCES`). On
 * a deployment that charges nothing, the one sentence about money is `sandbox.noPaymentStep`.
 *
 * The API's refusal sentences are not here: a screen shows them as served, never rewritten.
 *
 * `{name}` marks a value the screen fills in with `fillCopy`.
 */

/** The yes sentence: what a counterparty may say of an `active` standing, and nothing more. */
const YES_SENTENCE =
  "a registered legal body stands behind this agent, and Novi states its standing as active";

/** Said of the person on record, never of a company. */
const PERSON_ON_RECORD =
  "World ID shows a verified person behind this account; every legal body on it relies on that record.";

/** Said of the person whose record the human step accepted, never of a company. */
const VERIFIED_AS = "Verified human: {credential}";

const OPERATOR_CHECKS =
  "A Novi Corpus operator checks the declaration against the registry and your document. This is done by a person; it is not instant.";

/** The version of the pot's declaration the guardian ticks: the server stores it with the note and
 *  takes no other (`back/backend/src/legalBody/pot.ts`, `POT_DECLARATION`). */
export const POT_DECLARATION_VERSION = "pot-declaration-1";

/* The pot's sentences that more than one of its problems or refusals say. */
const POT_UNSUPPORTED = "The pot is not offered on this network.";
const POT_AGENT_WALLET =
  "The agent's wallet in the registry is not one a pot can use: it is unset, or it is your own wallet. Set your agent's wallet first.";
const POT_NOT_THIS_WALLET =
  "The wallet connected here is not this legal body's guardian wallet. Connect {address}.";
const POT_WRONG_NETWORK = "Your wallet is on another network. Switch it to {network}.";
const POT_BUILT_WRONG =
  "This page built the transaction with values it does not take, so it will not send it. Nothing was sent.";
/** The pot as the server or the record could not serve it just now: the record's sentence, and a
 *  click's read of the noted pot that failed. */
const POT_UNAVAILABLE = "The company's pot could not be read just now.";
/** One rule, two codes: the setup's and Send fee money's (Ruling R10). */
const POT_FEE_PLAIN_KEY =
  "Fee money goes only to a plain key, and your agent's wallet holds code, so nothing was sent to it.";

export const LEGAL_BODY_COPY = {
  page: {
    title: "A legal body for your agent",
    description:
      "Give an AI agent you already run a registered legal body: declare your company, sign the link, and point the agent's on-chain identity at the body.",
  },

  frame: {
    exit: "Exit",
    /** Beside Exit while signed in: the way back to the account's legal bodies from any step. */
    myAgents: "My agents",
    loading: "Loading…",
  },

  rail: {
    heading: "A legal body for your agent",
    footer:
      "Two signatures and one or two transactions from your wallet to get a legal body. Never an approval or a transfer.",
    /** Under the current phase; the done page has none. */
    inProgress: "In progress",
    labels: {
      signin: "Sign in",
      human: "Accountable human",
      company: "Your company",
      agreement: "Agreement",
      identity: "Your agent's identity",
      wallet: "Agent's wallet",
      link: "Sign the link",
      pointer: "Point your identity",
      payment: "Payment",
      filing: "Filing",
      done: "Done",
    },
  },

  door: {
    notOffered: "This deployment does not offer legal bodies on your own identity.",
    home: "Back to the home page",
    unreadable: "This deployment's settings could not be read just now.",
    retry: "Try again",
  },

  sandbox: {
    /** Above the choice of paths and on both doors: true of a formed company and a declared one. */
    banner: "Arc testnet. The company is a test, the wording is a draft, and nothing here is a filing.",
    noPaymentStep: "There is no payment step on this testnet deployment.",
  },

  wallet: {
    neverApprove: "Never approve or transfer anything to Novi Corpus.",
  },

  signIn: {
    title: "Sign in with the wallet that will answer for the legal body.",
    intro:
      "This wallet becomes the guardian: it signs the company's declaration and the link, and it is the wallet that answers for the legal body.",
    body: "Connect the wallet you want as the guardian, then sign in with it. Signing in asks for a signature only: it sends nothing and approves nothing.",
    checking: "Reading this wallet on the chain…",
    checkFailedTitle: "This wallet could not be read",
    checkFailed:
      "The chain could not be read just now, so it is not yet known whether this wallet can sign the declaration.",
    smartAccountTitle: "A plain wallet is needed",
    smartAccount:
      "This wallet is a smart account. The declaration needs a plain wallet signature, so a smart account cannot be the guardian here.",
    expiredTitle: "Your sign-in has ended",
    expired: "Sign in again with the same wallet to continue. Nothing was changed.",
    signInAgain: "Sign in again",
    errorTitle: "Something went wrong",
    retry: "Try again",
    continue: "Continue",
  },

  human: {
    titleAsk: "Who answers for this agent?",
    titleAccepted: "A person is on record.",
    introAccepted: PERSON_ON_RECORD,
    product:
      "A legal body for your agent needs a real person on record; a waiver is not accepted for this product.",
    points: [
      "Only a unique person can stand behind an agent's legal body.",
      "Novi Corpus stores a nullifier, never your name, document or face.",
      "Verify once; every legal body on this account relies on it.",
    ],
    notAccepted:
      "The record on this account is not accepted for this product: it needs a real World ID verification, and a waiver does not count.",
    unavailable:
      "This deployment cannot check World ID, so a legal body cannot be requested here.",
    checking: "Reading the guardian record…",
    unreadable: "The guardian record could not be read just now.",
    verify: "Verify with World ID",
    /** The accepted record line, said of the person: the credential World ID names. */
    verifiedAs: VERIFIED_AS,
    comeBack:
      "Come back to this page once World App shows your World ID and tap Verify; we keep your place.",
    continue: "Continue",
    retry: "Try again",
    back: "Back",
    worldErrors: {
      sameHuman:
        "This person is already on record for another account. World issues one proof per person here, so it cannot be used again for this account.",
      dismissed:
        "You dismissed the request in World App. Nothing was recorded; start again when you are ready.",
      other: "World ID could not finish the verification ({code}). Nothing was recorded; try again.",
    },
    guardianIdentity: {
      title: "Confirm who you are",
      none: "We verify the identity of the person in control once, through an identity check provider. An operator sends you the link by email, usually within one working day, and asks for your legal name as printed on your document. Nothing to do here yet.",
      pending: "We have your check and are recording it.",
      needs_review: "We are checking your result. This can take a day.",
      failed: "The check did not pass. We will write to you about the next step.",
      expired: "Your verification is due again. An operator sends you a new link.",
      revoked: "The check did not pass. We will write to you about the next step.",
      verified: "Verified",
      verifiedOn: "Verified on {date}",
      checked: "What is checked: a government document and a live photo, matched.",
      kept: "What we keep: the result, the date, the country and type of the document, and your name, encrypted.",
      never: "What we never see: the document itself, the photo, your date of birth or document number.",
      policy: "How a person is on record",
    },
  },

  thread: {
    loading: "Reading your companies and orders…",
    unreadable: "Your companies and orders could not be read just now.",
    retry: "Try again",
    placeholder: "This step is not available on this page yet.",
  },

  chooser: {
    title: "Which one do you want to continue?",
    intro:
      "You have more than one company or order in progress. Pick one; the others stay as they are.",
    unnamed: "A declared company",
    companyRow: "Declared; no order placed yet",
    orderStates: {
      draft: "Order placed; the link is not signed yet",
      reserved: "Novi Corpus is creating the body",
      deployed: "Body created; the pointer is not written yet",
      broken: "Body created; its pointer needs writing again",
      other: "Order in progress",
    },
    identity: "Identity {agentId}",
    continue: "Continue this one",
    formedUnnamed: "A company being formed",
    formedFiling: "Filing in progress",
    formedFiled: "Filed, ready to continue",
    formedFailed: "Filing failed",
  },

  closed: {
    /** The closed screen's heading: the order is closed, not done. */
    eyebrow: "This order",
    newOrder: "Place a new order",
    newCompany: "Declare a company",
    unknownTitle: "This order cannot move",
    unknownBody: "Its state is not one this page knows, so nothing is offered for it.",
  },

  /** The notices of the derivation, one per kind; `notice.ts` picks and fills them. */
  notices: {
    expired: {
      title: "This order expired",
      body: "A draft can be linked for 24 hours after it is placed, and this one was not. Nothing was created.",
    },
    lapsed: {
      title: "This order lapsed",
      reasons: {
        deadline_passed:
          "The signed link reached its deadline before the body was created, so the reservation closed without a body.",
        owner_changed:
          "The identity changed hands, and its new owner signed a link for it, so this reservation closed without a body.",
        foreign_body:
          "A body made for another owner already stands where this order's body would have been created, so the reservation closed without a body.",
        refused_before_send:
          "The chain would have refused to create the body, so nothing was sent and the reservation closed.",
        unknown: "The reservation closed without a body.",
      },
    },
    superseded: {
      title: "A newer order took this one's place",
      body: "A newer order for the same identity was linked, so this one can no longer move.",
    },
    replaced: {
      title: "Another body was linked in this one's place",
      body: "A newer body was linked to the same identity. Writing this body's pointer again would undo that, so it is not offered.",
    },
    newerOrder: "The newer order is {by}.",
    abandoned: {
      title: "This order was abandoned",
      body: "It can no longer move.",
    },
    order_revoked: {
      title: "This order was revoked",
      body: "A Novi Corpus operator revoked it, and a revocation is never undone.",
    },
    other_deployment: {
      title: "This order belongs to another deployment",
      body: "It was placed under another chain or factory, so it can be read here and nothing else.",
    },
    company_failed: {
      title: "The company's check did not pass",
      noReason: "The check did not pass, and no reason was recorded.",
      wayBackSandbox: "Declare the company again with a new test declaration.",
      wayBackProduction:
        "You can add evidence and wait for a new check, or declare the company again.",
    },
    company_revoked: {
      title: "The company's check was revoked",
      body: "A Novi Corpus operator revoked the check, so no new order can move on this company.",
    },
    company_awaiting_check: {
      title: "The company is waiting for its check",
      sandbox:
        "On this testnet the check is normally written at the declaration; this company was put back to be checked again, and waits for an operator.",
      production: OPERATOR_CHECKS,
    },
    company_abandoned: {
      title: "This company was abandoned",
      body: "It can take no order. Declare the company again to continue.",
    },
    formation_failed: {
      title: "The filing did not go through",
      body: "Fix the company details, or give up and ask for a refund.",
    },
    creating: {
      title: "Novi Corpus is creating the body",
      body: "This takes a few seconds; this page checks again every 5 seconds.",
    },
    winding_down: {
      title: "This body is winding down",
      body: "The body reports that it is winding down, so no pointer is offered for it.",
    },
    dissolved: {
      title: "This body is dissolved",
      body: "The body reports that it is dissolved, so no pointer is offered for it.",
    },
    broken_reason_unknown: {
      title: "The pointer is no longer seen",
      body: "The identity no longer points at this body, and the reason could not be read, so no pointer is offered for now.",
    },
    identity_taken: {
      title: "This identity already has a legal body",
      body: "Identity {agentId}: this identity already has a legal body; replacing it is not offered yet.",
    },
  },

  /* ── The steps after the gates. Each screen's own sentences, carried here so the one walk covers
        them from the start. ─────────────────────────────────────────────────────────────────── */

  filing: {
    title: "The state is filing the company",
    waiting:
      "doola files the company with the State of Wyoming. This usually takes {days} working days. The EIN comes from the IRS later and does not hold anything up.",
    sandbox: "On this test deployment the filing completes by itself in a few minutes.",
    filed: "Continue: read the agreement",
    fix: "Fix the company details",
    abandon: "Give up and get a refund",
    refund: "An operator refunds you. The filing has to be given up before it has started.",
    actions: "What the filing needs",
  },

  company: {
    declarationsOff: "This deployment does not take new declarations.",
    nameHintSandbox: "On this deployment the company name must say it is a test.",
    numberHintSandbox: "It starts with TEST- and no other company has used it.",
    nameCharset:
      "may hold only the characters a Wyoming entity name takes: A-Z, a-z, 0-9, spaces and & ' - , . ( ) +",
    sandboxCheck:
      "On this testnet the check is automatic and checks nothing. On production you upload a document showing you control the company, for example the IRS EIN letter naming you, and a Novi Corpus operator checks it against the Wyoming registry.",
    testLabel: "test declaration",
    draftWording: "draft wording",
    waiting: OPERATOR_CHECKS,
    evidenceUnavailable: "The upload is not available on this screen yet.",
    newDeclaration: "Declare the company again",
    writtenName: "Declared by {name} (from your identity verification)",
    writtenNameMissing: "Your identity record does not have a name yet.",
    wrongName: "Not your name? Write to us before you sign. Nothing is filed with a wrong name.",
    formed: {
      title: "Form the company",
      intro:
        "Novi Corpus files a Wyoming LLC for this agent through doola. The two names come from your identity record.",
      namesNote: "From your identity verification. Not your name? Write to us before paying.",
      nonUs: "A US tax number is not needed. The EIN takes a few weeks longer.",
      marketing: "You may also email me about Novi Corpus news and the launch.",
      create: "Create the company",
      sandboxIntro:
        "This deployment files a test company. No real name or tax number is collected.",
      cap: "The formed companies this deployment takes are all spoken for.",
      identity: "The identity record is not on file yet. Go back to the accountable human step.",
      texts: "The agreement is not approved for use yet.",
      fee: "The formation fee is {fee} USDC, paid on the next step.",
    },
    title: "Declare your company",
    introSandbox: "Name a test company and sign the statement of authority with this wallet.",
    introProduction:
      "Declare the Wyoming LLC behind your agent and sign the statement of authority with this wallet.",
    labels: {
      companyName: "Company name",
      filingNumber: "Filing number",
      declarantName: "Your legal name",
      declarantTitle: "Your title in the company",
    },
    /** Shown on a sandbox only, where both are inventions that say they are a test. */
    placeholdersSandbox: {
      companyName: "Example Test Holdings LLC",
      filingNumber: "TEST-0001",
    },
    numberHintProduction: "The number the Wyoming registry gave the company.",
    sign: "Sign the declaration",
    statementHeading: "The statement you sign",
    wordingVersion: "wording {version}",
    renewed:
      "The statement was issued too long ago to be accepted, so a new one was asked for. Read it and sign again.",
    declined: "Your wallet did not sign, so nothing was sent.",
    declinedOtherNetwork:
      "Your wallet did not sign, so nothing was sent. It is on another network than {network}, and a wallet may refuse to sign this statement until it is switched there.",
    notConnected:
      "This wallet is not connected in this browser just now, or another account is selected in it. Connect the wallet you signed in with to sign; nothing was asked for and nothing was sent.",
    refused:
      "The statement served does not match what you typed or this deployment ({problem}), so your wallet was not opened and nothing was declared.",
    noAnswer:
      "No answer came back, so whether the declaration was made is not known yet. Your companies are read again; if nothing changes, try again.",
    alreadyYours: "You already declared a company with this number.",
    continueWith: "Continue with that company",
    evidenceTitle: "Evidence for the check",
    abandon: "Abandon this company",
    abandonConfirm: "Abandoning closes this company for good: it can take no order again.",
    abandonYes: "Abandon it",
    abandonKeep: "Keep it",
    abandonNoAnswer:
      "No answer came back, so whether the company was abandoned is not known yet; try again.",
    /** The declaration doors' own problems, word for word, shown under the field they name. A
     *  door's answer, when it comes, is shown instead. */
    problems: {
      required: "is required",
      control: "holds a control or invisible character",
      otherSpace: "holds a space other than a plain space",
      doubleQuote: "holds a double quote",
      length: "must be {min} to {max} characters long",
      nameTest: "must say it is a test on this deployment",
      numberCharset: "may hold only A-Z, a-z, 0-9 and hyphens",
      numberTest:
        "must be a test number on this deployment: TEST- then 4 to 27 of A-Z, 0-9 and hyphens",
      declarantNameCharset: "may hold only letters, spaces, apostrophes, hyphens and full stops",
      declarantTitleCharset:
        "may hold only letters, digits, spaces, apostrophes, hyphens, full stops, &, / and commas",
    },
  },

  agreement: {
    placeOrder: "Place the order and read the agreement",
    continueDraft: "Continue with the order placed {hours} hours ago",
    unverifiable: "The agreement could not be checked against its hash.",
    hashNote: "this is what your link will sign",
    readCheckbox: "I have read this draft",
    draftWording: "draft wording",
    title: "Read the operating agreement",
    introBefore:
      "Placing the order freezes the operating agreement for it: the text, and the hash your link will sign. A draft order can be linked for 24 hours, and placing it sends nothing from your wallet.",
    introAfter:
      "This is the operating agreement of your order, frozen when the order was placed. Read it, then sign to adopt it for the company.",
    adopt: "Adopt this agreement: sign",
    adoptSentence:
      "Your signature adopts this agreement for the company in place of the one filed at formation.",
    adoptWorking: "Asking your wallet to adopt the agreement…",
    continueDraftOneHour: "Continue with the order placed 1 hour ago",
    continueDraftRecent: "Continue with the order placed less than an hour ago",
    draftOffered:
      "This company already has a draft order that can still be linked, so it is offered instead of a new one.",
    termsHeading: "The operating agreement",
    wordingVersion: "wording {version}",
    hashLabel: "Agreement hash",
    delay:
      "Amendment delay: {delay}. A change to this agreement takes effect only once this delay has passed since it was scheduled.",
    expiry:
      "This draft can be linked until {time}, {left} from now; after that it expires, and a new order is needed.",
    reading: "Reading the agreement…",
    unreadable: "The agreement could not be read just now.",
    retry: "Try again",
    continue: "Continue",
    cannotContinue:
      "The order is placed, but your orders could not be read again yet. Reload this page to continue with it.",
    noAnswer:
      "No answer came back, so whether the order was placed is not known yet. Your orders are read again; if nothing changes, try again.",
    /** Durations in words, for the delay, the expiry and a draft's age. */
    words: {
      lessThanAnHour: "less than an hour",
      hour: "1 hour",
      hours: "{n} hours",
      minute: "1 minute",
      minutes: "{n} minutes",
      second: "1 second",
      seconds: "{n} seconds",
    },
  },

  identity: {
    ownCard: "This wallet owns the identity",
    registerCard: "Register a new identity for this wallet",
    elsewhereCard: "The identity is owned by another key",
    taken: "this identity already has a legal body; replacing it is not offered yet",
    receiptUnreadable:
      "the registration could not be read from the receipt: enter the agent id by hand",
    title: "Which identity will the legal body stand behind?",
    intro:
      "Your agent's identity on the ERC-8004 identity registry of {network}. The key that owns it signs the link; this wallet stays the guardian either way.",
    ownBody:
      "Enter its agent id. This page reads the identity's owner on the chain, and it must be this wallet.",
    registerBody:
      "This wallet sends one transaction that registers a new identity it owns. It approves nothing and moves no funds.",
    elsewhereBody:
      "Enter its agent id. This page reads the identity's owner; that key signs the link wherever it lives, and you paste the signature back here.",
    chosen: "Chosen",
    choose: "Choose",
    agentIdLabel: "Agent id",
    agentIdHint: "the number the identity registry gave your agent",
    agentIdProblem:
      "must be a whole number as the registry gave it: digits only, no sign, no leading zero, within uint256",
    useIdentity: "Use this identity",
    readOwner: "Read the owner",
    reading: "Reading the identity's owner on the chain…",
    ownerUnread:
      "The chain could not be read just now, so the identity's owner is not known yet. Try again.",
    noIdentity:
      "There is no identity {agentId} on the identity registry of {network}. Check the number, or register a new identity.",
    ownedHere:
      "Identity {agentId} is owned by this wallet, so this wallet signs the link and writes the pointer here.",
    notThisWallet:
      "Identity {agentId} is owned by {owner}, not by this wallet. If that key signs for it, use the third card: the identity is owned by another key.",
    ownedElsewhere:
      "Identity {agentId} is owned by {owner}. That key signs the link wherever it lives and writes the pointer; this wallet stays the guardian.",
    toThirdCard: "Use the third card",
    continueHere: "Continue with this wallet",
    continueElsewhere: "Continue with that key",
    otherChain:
      "This site reads {network} only, and this deployment names another chain, so the identity cannot be read or registered here.",
    uriLabel: "Agent URI",
    uriHint: "optional; where your agent's registration file lives",
    uriProblems: {
      length: "must be at most 2,048 characters long",
      characters: "holds a space, a control or an invisible character",
      https: "must be an https address",
    },
    register: "Register a new identity",
    notConnected:
      "This wallet is not connected in this browser just now. Connect it again to register; nothing was sent.",
    waiting:
      "Waiting for the registration to be confirmed on the chain. This can take up to 3 minutes.",
    viewTransaction: "See the transaction",
    reverted: "The registration transaction failed on the chain, so no identity was registered.",
    noReceipt:
      "No receipt came back within 3 minutes, so whether the registration landed is not known yet. Look at the transaction; once it is confirmed, enter the agent id by hand.",
    rejected: "Your wallet did not send the registration, so nothing was registered. It said: {message}",
    rejectedNoWords: "Your wallet did not send the registration, so nothing was registered.",
    cannotSendWayOut:
      "If another key that can send owns your agent's identity, use the third card.",
    otherNetwork:
      "Your wallet is on another network than {network}. Switch it there and register again; nothing was sent.",
    refusedBeforeWallet:
      "The registration was refused before your wallet opened ({problem}), so nothing was sent.",
    /** The label beside the agent id: on the identity step's first card, and on the link and
     *  pointer steps. */
    yourIdentity: "Your agent's identity",
    suggestionBody:
      "The identity you picked or registered on this visit. Continuing reads its owner on the chain again first.",
    continueWith: "Continue with {agentId}",
    orChooseAnother: "Or choose another identity",
  },

  /** The agent's own wallet, written on its identity between the identity and the link. The page
   *  never makes a key: it takes an address, and the signature that wallet made. */
  agentWallet: {
    title: "Your agent's wallet",
    why: "Your agent needs a wallet of its own: the key it signs and pays with. Anyone it pays can then find its company. It must not be your wallet.",
    checking: "Reading the agent's wallet on the registry.",
    unreadable: "The registry could not be read just now. Nothing was changed.",
    retry: "Try again",
    todayGuardian: "Today the registry names your own wallet as this agent's wallet.",
    todayNone: "Today the registry names no wallet for this agent.",
    hasKeyTitle: "My agent has its own key",
    hasKeyLine: "Give the key's address. The key signs one message to prove itself.",
    noKeyTitle: "My agent has no key yet",
    noKeyLine: "Create one where your agent runs. The key never passes through this site.",
    providerTitle: "My agent has a wallet with a provider",
    providerLine:
      "Give the wallet's address. The wallet signs one message through its provider. It must already exist on {network}.",
    noKeyAsk:
      'Ask your agent: "Create an Ethereum key for yourself. Keep the private key in your own secret storage and never show it. Tell me only the address."',
    noKeyCommandIntro: "Or, with Foundry installed where the agent runs:",
    noKeyCommand: "cast wallet new ~/.foundry/keystores agent-key",
    addressLabel: "The agent's wallet address",
    /** Under the address field. An empty field is not an address either. */
    addressProblems: {
      not_address: "This is not an address: it starts with 0x and has 40 more characters.",
      zero: "This address cannot be an agent's wallet.",
      guardian: "This is your own wallet. The agent's wallet must be a different one.",
    },
    prepare: "Prepare the message",
    messageIntro: "The agent's wallet signs this message. It is valid for a few minutes.",
    messageHeading: "The message to sign",
    signAsk:
      'Ask your agent: "Sign this EIP-712 message with your key and give me the signature."',
    signCommandIntro: "Or save it as message.json and run:",
    signCommand: "cast wallet sign --data --from-file message.json --account agent-key",
    countdown: "Valid for {seconds} more seconds.",
    expired: "This message has expired. Prepare a new one.",
    signatureLabel: "The signature",
    /** Said under the signature field, after its label, as the paste panel's problems are. */
    signatureEmpty: "is empty: paste the signature the agent's wallet made",
    signatureProblems: {
      wrong_key: "This signature was not made by that wallet's key, or not over this message.",
      compact:
        "This is a compact signature of 64 bytes. The registry takes the usual 65-byte form: sign again without the compact option.",
      wrapped:
        "This signature is made for a wallet that does not exist on {network} yet. The wallet must exist on the chain first.",
      not_on_chain:
        "No wallet exists at this address on {network} yet. A provider's wallet must exist on the chain before it can sign.",
      contract_refused: "The wallet did not accept this signature.",
    },
    send: "Write the wallet on the identity",
    sending: "Waiting for your wallet.",
    waiting: "Waiting for the registry to show the wallet.",
    wouldRevert:
      "The registry would refuse this transaction, so nothing was sent. Prepare a new message.",
    reverted: "The transaction did not go through. Nothing was changed. Prepare a new message.",
    notThisWallet:
      "The wallet connected here does not own this identity. Connect the wallet that owns it.",
    noIdentity:
      "There is no identity {agentId} on the identity registry of {network} now, so no wallet can be written on it.",
    domainMismatch:
      "The registry's signing domain is not the one this deployment names, so no message was prepared.",
    declined: "Your wallet did not send the transaction, so nothing was written.",
    /** `{minutes}` is the receipt's wait, from `REGISTER_RECEIPT_TIMEOUT_MS`. */
    noReceipt:
      "No receipt came back within {minutes} minutes, so whether the wallet was written is not known yet. Look at the transaction, then check again. If it is not on the chain, prepare a new message.",
    ownerChanged:
      "The identity's owner changed since the message was prepared. Prepare a new message.",
    /** The one-click way to sign, when the agent's key is another account of the browser wallet. */
    otherAccountTitle: "Sign with another account of your browser wallet",
    otherAccountHow:
      "In your wallet, connect the agent's account to this site as well, and keep your own account selected.",
    otherAccountSign: "Sign with {address}",
    otherAccountDeclined:
      "Your wallet did not sign with that account. You can paste the signature instead.",
    elsewhere:
      "This identity is owned by another key. That key must write the agent's wallet on the registry (setAgentWallet), with a signature of the new wallet that is at most five minutes old. This page checks again by itself.",
    checkAgain: "Check again",
    line: "This agent's wallet: {address}",
    /** The done page's card, for a legal body made before the rule: its identity still names the
     *  guardian's own wallet (`doneLine`) or none (`doneLineNone`). A click opens the step here. */
    doneTitle: "Set your agent's wallet",
    doneLine:
      "The registry still names your own wallet as this agent's wallet. A payment made by the agent does not lead to its company yet.",
    doneLineNone:
      "The registry names no wallet for this agent. It cannot act under its Charter until it has one.",
    /** The allowlist refused the transaction this page built: ours, so said as ours. */
    callRefused:
      "The transaction was refused before your wallet opened ({problem}), so nothing was sent.",
    callProblems: {
      no_wallet_context:
        "This page built the transaction without the identity, your wallet or the chain's time, so it will not send it. Nothing was sent.",
      set_agent_wallet_args:
        "This page built the transaction with values it does not take, so it will not send it. Nothing was sent.",
      other_identity:
        "This page built the transaction for another identity than this one, so it will not send it. Nothing was sent.",
      wallet_is_zero:
        "This page built the transaction with no wallet in it, so it will not send it. Nothing was sent.",
      wallet_is_guardian:
        "This page built the transaction with your own wallet as the agent's wallet, so it will not send it. Nothing was sent.",
      deadline_out_of_window:
        "The message's time does not fit the chain's clock, so this page will not send it. Nothing was sent. Prepare a new message.",
      signature_shape:
        "The signature is not whole bytes, or it is too long, so this page will not send it. Nothing was sent.",
      sends_value:
        "This page built the transaction with a value attached, so it will not send it. Nothing was sent.",
      wrong_chain:
        "This page built the transaction for another chain than this deployment's, so it will not send it. Nothing was sent.",
      not_the_registry:
        "This page built the transaction for another contract than the identity registry, so it will not send it. Nothing was sent.",
      not_the_pinned_abi:
        "This page built the transaction from another interface than the registry's, so it will not send it. Nothing was sent.",
      wallet_on_another_chain:
        "Your wallet is on another network than {network}. Switch it there and send again. Nothing was sent.",
      chain_not_configured:
        "This site sends to {network} only, and this deployment names another chain, so the wallet cannot be written here. Nothing was sent.",
    },
  },

  /** The company's pot: a Safe the guardian owns alone, from which the agent's own key takes USDC
   *  up to a ceiling in each fixed thirty-day period. Every sentence about the ceiling says "in
   *  each thirty-day period"; "per thirty days" is kept for the grant's own amounts, which the
   *  Charter counts back from each act. A stopped pot is said only as read: the agent's key cannot
   *  take from it (Ruling R5). */
  pot: {
    cardTitle: "Give your agent an allowance",
    cardLine:
      "Keep the company's money in a pot that only your wallet owns. Your agent's key takes from it up to a ceiling in each thirty-day period.",
    title: "The company's pot",
    what: "The pot is a Safe wallet on {network}. Your wallet is its only owner. Your agent's key can take USDC from it up to the ceiling. Novi Corpus holds no key and no money.",
    periods:
      "The pot counts in fixed periods of thirty days, one after the other, from the minute it is created. What is not taken in a period is not carried over. Around the end of a period your agent's key can take the ceiling just before it ends and the ceiling again just after, so up to twice the ceiling within a few minutes.",
    limits:
      "The ceiling is one amount for each period. It does not look at who is paid, at the size of one payment or at the kind of act, and it does not cover money paid straight to your agent's key.",
    keepLittle: "Keep in the pot only what your agent needs.",
    noRecovery:
      "If you lose this wallet, nobody can recover the money in the pot, Novi Corpus included.",
    checking: "Reading the pot on the chain.",

    /* The form. */
    ceilingLabel: "Ceiling for each thirty-day period, in USDC",
    ceilingMax:
      "At most {cap} USDC, the grant's thirty-day total for buying, paying and engaging a contractor.",
    ceilingNoGrant: "Choose the most your agent's key may take in each thirty-day period.",
    grantNoSpending:
      "Your agent's grant allows no buying, no paying and no engaging of contractors, so a pot has nothing to release.",
    grantEnds:
      "Your agent's grant ends on {date}. The pot does not stop by itself on that day: stop the allowance then.",
    grantUnreadable:
      "Your agent's grant could not be read just now, so the ceiling's limit cannot be shown.",
    ceilingProblems: {
      empty: "Give a ceiling.",
      not_whole: "Write a whole number of USDC, with no decimals.",
      zero: "The ceiling must be at least 1 USDC.",
      too_large: "This is more than a pot takes.",
      above_grant: "This is above the {amount} USDC your agent's grant allows per thirty days.",
    },
    fundLabel: "Put in the pot now, in USDC (optional)",
    fundLine:
      "You can add more later with Add money, or by sending USDC to the pot's address from any wallet.",
    gasLabel: "Fee money for your agent's key, in USDC",
    gasLine:
      "Your agent's key pays a small network fee each time it takes from the pot, so it needs a little USDC of its own first. This amount goes straight to the key and is outside the ceiling.",
    gasContract:
      "Your agent's wallet is a contract wallet. It pays its fees its own way, so nothing is sent to it here. It must be able to call a contract itself to take from the pot.",
    amountProblems: {
      not_amount: "Write an amount in USDC, such as 25 or 0.5.",
      too_precise: "USDC has six decimals at most.",
      too_large: "This amount is too large.",
      gas_too_large: "Fee money is at most 1 USDC. Money for the company goes in the pot.",
      empty: "Give an amount.",
      /** Add money and Send fee money never send 0. */
      zero: "Give an amount above 0 USDC.",
    },

    /* The review and the setup. */
    review: "Review",
    reviewTitle: "Check before you sign",
    reviewOwner: "Only owner of the pot: {address} (your wallet)",
    reviewAgent: "The key that may take from it: {address} (your agent's wallet in the registry)",
    /** The noted pot that never got code, when the registry names another key now (Ruling R19):
     *  it is created at its noted address, for the key it was noted for, with no money. */
    reviewAgentNoted:
      "The key that may take from it: {address}, the key this pot was noted for. Your agent's wallet in the registry is now {registry}.",
    reviewKeyChanged:
      "So this transaction puts no money in the pot and sends nothing to that earlier key. Once the pot exists, use My agent has a new key to let the new key take from it, then add money.",
    reviewCeiling:
      "Ceiling: {amount} USDC in each thirty-day period. The first period starts when the pot is created.",
    reviewAddress: "The pot's address will be {address}",
    reviewTotal:
      "Your wallet will ask you to send {total} USDC to a contract called Multicall3. In the same transaction it creates the pot, puts {fund} USDC in it and sends {gas} USDC to your agent's key. Nothing goes to Novi Corpus.",
    reviewFundOnly:
      "Your wallet will ask you to send {total} USDC to a contract called Multicall3. In the same transaction it creates the pot and puts the {total} USDC in it. Nothing goes to Novi Corpus.",
    reviewGasOnly:
      "Your wallet will ask you to send {total} USDC to a contract called Multicall3. In the same transaction it creates the pot and sends the {total} USDC to your agent's key. The pot starts empty. Nothing goes to Novi Corpus.",
    reviewNoMoney:
      "Your wallet will ask you to confirm a transaction that sends no money. It creates the pot.",
    /** The tick box: the server's `POT_DECLARATION.text`, word for word. */
    declaration:
      "I declare this pot for the company: it holds the company's money, and its address, its ceiling, what was taken from it and what it holds will show in the public record.",
    declarationNeeded: "Tick the declaration to go on.",
    create: "Create the pot",
    back: "Change something",
    /** "Create the pot" before the wallet opens: the simulation, the estimate, the reads again and
     *  the note. */
    checkingSend: "Checking the transaction before your wallet opens.",
    sending: "Waiting for your wallet.",
    waiting: "Waiting for the pot to appear on the chain.",
    waitingChange: "Waiting for the chain.",
    created: "The pot exists. This is what the chain shows:",
    done: "Done. This is what the chain shows now:",
    /** A click's own problems, before or at the wallet. */
    problems: {
      unsupported: POT_UNSUPPORTED,
      agent_wallet: POT_AGENT_WALLET,
      pot_exists: "A pot already exists at this address. Nothing was sent.",
      not_enough: "Your wallet holds {balance} USDC. This needs {total} USDC and a small fee.",
      not_this_wallet: POT_NOT_THIS_WALLET,
      wrong_network: POT_WRONG_NETWORK,
      record_failed: "Novi Corpus could not note the pot's address, so nothing was sent. Try again.",
      would_revert: "The chain would refuse this transaction, so nothing was sent.",
      declined: "You declined in your wallet. Nothing was sent.",
      reverted: "The transaction did not go through. Nothing changed and no money moved.",
      no_receipt:
        "No answer from the chain after three minutes. Check again before you start over: the transaction may have gone through.",
      read_failed: "The chain could not be read just now. Nothing was changed.",
      refused: "This transaction is not one this page may send, so nothing was sent.",
      /** A click's read of the noted pot from the server that failed. */
      pot_unreadable: POT_UNAVAILABLE,
      /** Read again before the note: the noted pot or the agent's wallet is not the review's. */
      stale_plan:
        "Something changed since your review: the pot noted for this legal body, or your agent's wallet in the registry. Nothing was sent. Review it again.",
      /** The wallet could not pay the transaction's network fee. */
      no_gas:
        "Your wallet does not hold enough USDC to pay the network fee of this transaction. Nothing was sent.",
      /** One pot for life: the noted address that never got code is set up again only as noted.
       *  The way out of a ceiling the guardian no longer wants (Ruling R34): create it with no
       *  money, then change the allowance before adding any. */
      noted_pot:
        "A pot with a ceiling of {amount} USDC was noted for this legal body and is not on the chain yet. Keep that ceiling to create it: another ceiling would make a second pot. To use another ceiling, create it with no money, then use Change the allowance before you add any. Nothing was sent.",
    },
    /** The allowlist's refusals of a pot call, before the wallet opened: one plain sentence for
     *  each code it can give, never the code itself. */
    refusals: {
      bad_request:
        "This page could not read the transaction it built, so it will not send it. Nothing was sent.",
      wrong_chain:
        "This page built the transaction for another chain than this deployment's, so it will not send it. Nothing was sent.",
      pot_chain_unsupported: POT_UNSUPPORTED,
      no_pot_context:
        "This page built the transaction without the pot's facts read in this click, so it will not send it. Nothing was sent.",
      no_order:
        "This page built the transaction without this legal body's order, so it will not send it. Nothing was sent.",
      order_on_another_deployment:
        "This legal body belongs to another deployment, so this page sends nothing for its pot. Nothing was sent.",
      order_not_linked:
        "This legal body is not linked, or it was revoked, so this page sends nothing for its pot. Nothing was sent.",
      guardian_is_not_the_orders:
        "This page built the transaction for another guardian than this legal body's, so it will not send it. Nothing was sent.",
      gas_out_of_bounds:
        "The gas limit is not one this page sends for this transaction, so nothing was sent.",
      not_multicall3:
        "This page built the setup for another contract than Multicall3, so it will not send it. Nothing was sent.",
      not_the_pinned_abi:
        "This page built the transaction from another interface than the pot's, so it will not send it. Nothing was sent.",
      value_mismatch:
        "The amount the transaction would carry is not the sum of what goes in the pot and to your agent's key, so this page will not send it. Nothing was sent.",
      setup_args:
        "The setup is not the one this page rebuilt from your choices, so it will not send it. Nothing was sent.",
      wallet_is_zero: POT_AGENT_WALLET,
      wallet_is_guardian: POT_AGENT_WALLET,
      ceiling_out_of_bounds:
        "The ceiling must be a whole number of USDC from 1 to 3,000,000,000, so nothing was sent.",
      fund_out_of_bounds:
        "This amount for the pot is not one this page sends: at most 1,000,000,000 USDC, six decimals at most, and more than 0 when you add money. Nothing was sent.",
      agent_gas_out_of_bounds:
        "Fee money is at most 1 USDC, six decimals at most, and more than 0 when you send it alone. Nothing was sent.",
      fee_money_needs_plain_key: POT_FEE_PLAIN_KEY,
      fee_money_contract_wallet: POT_FEE_PLAIN_KEY,
      salt_out_of_bounds: POT_BUILT_WRONG,
      sends_value:
        "This page built the transaction with a value attached where none belongs, so it will not send it. Nothing was sent.",
      not_the_pot:
        "This page built the transaction for another address than this legal body's pot, so it will not send it. Nothing was sent.",
      exec_args:
        "The transaction is not the one this page rebuilt for the pot, so it will not send it. Nothing was sent.",
      nothing_to_stop:
        "The allowance of this pot is already switched off, so there is nothing to stop. Nothing was sent.",
      allowance_still_on:
        "The allowance of this pot is still switched on. Stop it first, then take the money back. Nothing was sent.",
      nothing_to_withdraw: "The pot holds nothing to take back. Nothing was sent.",
      restore_other_module:
        "This pot has another add-on switched on, so this page will not start it again. Nothing was sent.",
      not_usdc:
        "This page built the transfer for another token than USDC, so it will not send it. Nothing was sent.",
      transfer_args:
        "The transfer is not the one this page rebuilt from your amount, so it will not send it. Nothing was sent.",
      chain_not_configured:
        "This site sends to {network} only, and this deployment names another chain, so nothing was sent.",
      wallet_on_another_chain: POT_WRONG_NETWORK,
      wallet_is_not_the_guardian: POT_NOT_THIS_WALLET,
    },
    checkAgain: "Check again",
    retry: "Try again",
    viewTransaction: "See the transaction",
    /** The setup's receipt said it went through, and the read of the pot after it failed. */
    readBackFailed:
      "The transaction went through, but the chain could not be read just now to show the pot. Check again.",

    /* What the card shows of the pot, as read from the chain. */
    shownAddress: "The pot's address: {address}",
    shownOwner: "Only owner: {address}",
    shownAgent: "May take from it: {address}",
    shownCeiling: "Ceiling: {amount} USDC in each thirty-day period",
    shownSpent:
      "Taken in this period: {spent} USDC. {left} USDC left until {date}, when the next period starts.",
    shownBalance: "In the pot: {balance} USDC",
    shownFeeMoney: "Your agent's key holds {amount} USDC for network fees.",
    feeMoneyLow:
      "This is low. Each take costs the key a small fee in USDC, and the network refuses a take the key cannot pay for. Send it a little with Send fee money.",
    stoppedLine: "The agent's key cannot take from this pot: its allowance is switched off.",
    limitsNotRead:
      "This pot is set up in a way this page does not read: {reason}. Its ceiling is not shown.",
    limitReasons: {
      other_module: "it has another add-on switched on",
      guard_set: "it has a guard",
      other_handler: "it has a fallback handler other than Safe's own",
      usdc_approved: "it lets your agent's key spend its USDC directly, outside the ceiling",
      other_delegate: "a key other than your agent's wallet may take from it",
      other_token: "it has an allowance on something other than USDC",
      other_period: "its period is not thirty days",
    },
    notYours: "The address noted for this legal body is not a pot that only your wallet owns.",
    onePot:
      "A legal body keeps one pot for its whole life. To give your agent an allowance again, use Start again on this pot.",

    /* The guardian's actions on the pot. */
    changeTitle: "Change the allowance",
    changeLine:
      "Sets a new ceiling from now on. The running period, and what was already taken in it, stay as they are.",
    changeSend: "Set the new ceiling",
    stopTitle: "Stop the allowance",
    stopLine:
      "Removes your agent's key from the pot and switches the allowance off, in one transaction. Your agent's key can take nothing through the allowance after it. The money stays in the pot until you take it back.",
    stopSend: "Stop the allowance",
    withdrawTitle: "Take the money back",
    withdrawLine: "Sends everything in the pot, {balance} USDC, to your wallet.",
    withdrawSend: "Take {balance} USDC back",
    startAgainTitle: "Start again",
    /** Names the key the allowance goes to (Ruling R23): the click refuses any other. */
    startAgainLine:
      "Lets this key take from the pot again: {address}, your agent's wallet in the registry. One transaction, with the ceiling you choose. A new thirty-day period starts now, with nothing taken yet.",
    startAgainSend: "Start again",
    newKeyTitle: "My agent has a new key",
    newKeyLine:
      "Your agent's wallet in the registry is now {address}. This takes the old key off the pot and lets the new one take from it, with the ceiling you choose, in one transaction. A new thirty-day period starts now for the new key.",
    newKeySend: "Move the allowance to the new key",
    /** An action's click read the pot again and found it other than the card showed it: another
     *  tab, or a change made elsewhere. Nothing is sent, and the card reads it again. */
    actionMoved:
      "The pot is not as this page showed it, so nothing was sent. It is read again now: check what it shows, then try again.",
    /** An action the guardian's wallet cannot pay the network fee of, its balance read again. */
    feeShort:
      "Your wallet holds {balance} USDC, which does not pay the network fee of this transaction. Nothing was sent.",
    addMoneyTitle: "Add money",
    addMoneyLine: "Sends USDC from your wallet to the pot, {address}. Nothing goes to Novi Corpus.",
    addMoneyLabel: "Amount, in USDC",
    addMoneySend: "Add {amount} USDC",
    feeMoneyTitle: "Send fee money",
    feeMoneyLine:
      "Sends a little USDC from your wallet to your agent's key, {address}, for its network fees. It is outside the ceiling. At most 1 USDC.",
    feeMoneySend: "Send {amount} USDC",
    offRecordTitle: "Take the pot off the public record",
    offRecordLine:
      "The record stops showing this pot beside the legal body. The pot, its money and its allowance stay as they are. If the pot exists on the chain, a search by its address still leads to this legal body, marked as a former pot, unless a newer legal body has replaced this one.",
    /** The take off of a noted address that is not a pot only the guardian's wallet owns (Ruling
     *  R32): nothing of a pot is claimed for it. */
    offRecordNotYoursLine:
      "The record stops showing this address beside the legal body. Nothing on the chain changes.",
    offRecordSend: "Take it off the record",
    offRecord:
      "This pot is off the public record. A search by its address still leads to this legal body, marked as a former pot, unless a newer legal body has replaced this one.",
    backOnTitle: "Put the pot back on the public record",
    backOnSend: "Put it back on the record",
    /** Taking the pot off the record, or putting it back, with no answer the server wrote: the
     *  request may have landed, so this claims nothing about the record, and the page reads it
     *  again. */
    recordAnswerLost:
      "The answer did not come back, so this page reads the pot again to show where it stands.",

    /* The agent's side. The commands are data the page fills in, shown in copy boxes. */
    agentTitle: "For your agent",
    agentLine:
      "Your agent takes from the pot with its own key. Novi Corpus never holds that key and sends nothing for it.",
    agentMcp:
      "Over MCP: the tool get_pot reads what is left, and prepare_pot_take prepares a take for the agent's key to send.",
    agentCommandIntro:
      "Or, with Foundry where the agent runs, one command. PAYEE is who is paid. UNITS is the amount in millionths of a USDC: 1 USDC is 1000000.",
    agentCommand:
      'cast send {module} "executeAllowanceTransfer(address,address,address,uint96,address,uint96,address,bytes)" {pot} {token} PAYEE UNITS 0x0000000000000000000000000000000000000000 0 {agent} 0x --gas-limit 200000 --rpc-url {rpc} --account agent-key',
    agentReadIntro: "To read what is left:",
    agentRead:
      'cast call {module} "getTokenAllowance(address,address,address)(uint256[5])" {pot} {agent} {token} --rpc-url {rpc}',
    agentReadLine:
      "The five numbers are the ceiling, what was taken in this period, the period in minutes, the minute the period started, and a counter.",
    copy: "Copy",
    copied: "Copied",
    copyByHand: "Select the text above and copy it.",

    /* The public record's sentence, one per state the record serves beside a statement. */
    recordCeiling:
      "The guardian declared this pot for the company: {address}. The agent's key may take up to {amount} USDC from it in each thirty-day period; the current one ends on {ends}. It holds {balance} USDC. Read from the chain on {date}.",
    recordStopped:
      "The guardian declared this pot for the company: {address}. The agent's key cannot take from it: its allowance is switched off. It holds {balance} USDC. Read from the chain on {date}.",
    recordNotRead:
      "The guardian declared this pot for the company: {address}. Its limits were not read.",
    recordUnavailable: POT_UNAVAILABLE,
  },

  link: {
    sign: "Sign",
    creating: "Novi Corpus is creating the body",
    placeNewOrder: "Place a new order",
    tryAgainSoon: "Your order is kept: try again in a moment, with Sign.",
    buildFailed:
      "Something went wrong building the link on this page, so the link door could not read it, and nothing was created. Sign again; if this repeats, reload the page.",
    title: "Sign the link with this wallet",
    intro:
      "Your wallet signs one message, the link, which binds identity {agentId} to the legal body of this order. Signing sends nothing and approves nothing.",
    howItWorks:
      "When you click Sign, this page asks for the link, checks every field of it against your order, your identity, the agreement you read and this wallet, and only then opens your wallet.",
    fieldsHeading: "The link you sign",
    fields: {
      agentId: "agentId",
      guardian: "guardian",
      amendmentDelay: "amendment delay",
      agreementHash: "agreement hash",
      deadline: "deadline",
      domain: "domain",
    },
    yourWallet: "your wallet",
    theOneYouRead: "the one you read",
    deadlineIn: "in {left}",
    lessThanAMinute: "less than a minute",
    domainValue: "{name}, version {version}, chain {chainId}, verifying contract {contract}",
    asking: "Asking for the link…",
    inWallet: "Waiting for your wallet…",
    sending: "Sending the signed link…",
    retry: "Try again",
    identityUnknown:
      "The identity for this order is not known on this page. Go back to the identity step and pick it again.",
    refused:
      "The link served does not match your order, your identity, the agreement you read or this wallet ({problem}), so your wallet was not opened and nothing was signed.",
    ownerMoved:
      "This identity is no longer owned by this wallet, as the chain reads it now, so your wallet was not opened and nothing was signed. Pick the identity again.",
    ownerMissing:
      "The link came back without the identity's owner, so your wallet was not opened and nothing was signed. Sign again; if this repeats, reload the page.",
    declined: "Your wallet did not sign the link, so nothing was sent.",
    declinedOtherNetwork:
      "Your wallet did not sign the link, so nothing was sent. It is on another network than {network}, and a wallet may refuse to sign the link until it is switched there.",
    notConnected:
      "This wallet is not connected in this browser just now. Connect it again to sign; nothing was asked for and nothing was sent.",
    noAnswerMessage: "No answer came back for the link, so nothing was signed. Try again.",
    noAnswerSubmit:
      "No answer came back, so whether the link was taken is not known yet. Your order is read again; if it has not moved, try again, and the same signed link is sent.",
    unreadableAnswer:
      "The answer to the signed link could not be read, so whether it was taken is not known yet. Your order is read again; if it has not moved, sign again.",
  },

  /** The identity is owned by another key: the link is signed and the pointer sent wherever that
   *  key lives. Data only on these screens: typed data, a hex value, a decoded call. */
  paste: {
    signerNote:
      "sign this with the key that owns identity {agentId}, wherever it lives: your agent's signer, a hardware wallet, or circle wallet sign typed-data; a signer that takes whole typed data signs it as is; an ethers signer must drop types.EIP712Domain",
    sendFromOwner: "send this from the owner key",
    sent: "I sent it",

    title: "Sign the link with the key that owns the identity",
    intro:
      "Identity {agentId} is owned by another key. That key signs the link wherever it lives, and you paste its signature back here; your wallet is not asked for anything on this step.",
    howItWorks:
      "When you click Get the link, this page asks for the link with a six-hour deadline, checks every field of it against your order, your identity, the agreement you read and this wallet as the guardian, and only then shows it to copy.",
    getLink: "Get the link",
    owner: "The identity's owner, as the link door read it: {owner}.",
    typedDataHeading: "The typed data to sign, exactly as served",
    copy: "Copy",
    copied: "Copied",
    copyByHand: "Select the text above and copy it.",
    signatureLabel: "The signature",
    signatureHint: "hex, with or without 0x, at most 2,048 bytes",
    send: "Send the signature",
    /** Said under the signature field; the field's label comes first. */
    problems: {
      empty: "is empty: paste the signature the owner key made",
      not_hex: "holds a character that is not hex: only 0-9 and a-f, with or without 0x",
      odd_length: "has an odd number of hex digits, so it is not whole bytes",
      too_long: "is longer than 2,048 bytes",
    },
    refused:
      "The link served does not match your order, your identity, the agreement you read or this wallet as the guardian ({problem}), so it is not shown and nothing should be signed.",
    ttlAboveMax:
      "This deployment serves links for less than six hours, so a link to sign elsewhere cannot be asked for here.",
    stale:
      "This link's deadline is too close to use, so the signature was not sent. Get the link again and sign the new one.",
    tryAgainSoon: "Your order is kept: in a moment, send the same signature again.",
    unreadableAnswer:
      "The answer to the signature could not be read, so whether it was taken is not known yet. Your order is read again; if it has not moved, send the signature again.",
    mcp: "An automated agent can take these steps with the MCP tools get_link_message, submit_link and get_binding instead. They need an API key, minted on /agents/connect as for any connection, and that key reaches further than one link: it acts for your whole account. This page never asks for one.",

    pointerTitle: "Write the pointer from the key that owns the identity",
    pointerIntro:
      "Identity {agentId} is owned by another key, so that key sends the one transaction that points the identity at its legal body. This page shows the call to send; your wallet is not asked for anything on this step.",
    checking: "Checking the pointer against the factory, and the identity's owner, on the chain…",
    checksUnread: "The chain could not be read just now, so the call is not shown yet. Try again.",
    callRefused:
      "The call could not be built for this order ({problem}), so it is not shown and nothing should be sent.",
    pointerStop: "The call is not shown, so nothing should be sent from the owner key: {reason}.",
    noIdentity:
      "The identity registry has no identity {agentId} now, so no pointer can be written for it.",
    rows: {
      from: "from",
      to: "to",
      function: "function",
      agentId: "agentId",
      key: "key",
      value: "value",
      nativeValue: "native value",
    },
    notes: {
      from: "the identity's owner",
      to: "the identity registry",
      value:
        "96 bytes: version 1, chain {chainId}, body {body}; the same bytes the factory encodes for this body",
      nativeValue: "nothing is sent with the call",
    },
    calldataHeading: "The calldata",
    gasSandbox:
      "The owner key pays the gas: it needs a little native USDC on Arc testnet, which the Arc testnet faucet provides.",
    gasProduction: "The owner key pays the gas: it needs a little native USDC on Arc.",
    watching:
      "This page reads the identity's pointer on the chain every 30 seconds for two minutes. Once the transaction is sent, click I sent it.",
    seen: "The pointer is on the chain. Click I sent it, and Novi Corpus checks it now.",
    watchEnded:
      "This page has stopped reading the pointer. Once the transaction is sent, click I sent it.",
    refreshing: "Asking Novi Corpus to check the pointer…",
    refreshNoAnswer: "No answer came back from the check just now.",
    keepChecking:
      "Novi Corpus has not seen the pointer yet. Once the transaction is confirmed, click I sent it again, and Novi Corpus checks it.",
    retry: "Try again",
  },

  pointer: {
    sentence:
      "Your wallet will write a pointer from identity {agentId} to body {body} on {network}; this is the only transaction, and it approves nothing.",
    networkSandbox: "Arc testnet",
    networkProduction: "Arc",
    factoryMismatch: "the pointer could not be checked against the factory",
    identityMoved:
      "The identity changed hands since the link; its current owner needs a new link, which makes a new body.",
    gas: "Your wallet needs a little native USDC on Arc testnet for gas; the Arc testnet faucet provides it.",
    keepChecking: "We keep checking; this page updates when the pointer is seen.",
    cannotSend:
      "Your wallet can sign but it cannot send a transaction on Arc, so it cannot write the pointer. The identity's owner must be a key that can send, or its sponsor must pay.",
    chainUnread: "could not read the chain just now",
    sevenDays:
      "Novi Corpus stops watching an unpointed body after 7 days and the order no longer counts against your open orders; the body stays where it is, and a refresh from this page links it.",

    /* The browser branch's step: this wallet owns the identity and writes the pointer. */
    title: "Write the pointer with this wallet",
    loading: "Reading this order's binding…",
    bindingUnread: "This order's binding could not be read just now. Try again.",
    checksUnread: "The chain could not be read just now, so the pointer is not offered yet. Try again.",
    retry: "Try again",
    callRefused:
      "The pointer transaction could not be built for this order ({problem}), so your wallet is not asked to send it.",
    stop: "Your wallet is not asked to send the pointer: {reason}.",
    notThisWallet:
      "Identity {agentId} is owned by {owner}, which is not the wallet connected in this browser just now. Connect that wallet to write the pointer; nothing was sent.",
    noIntent: {
      title: "No pointer is asked for this order",
      body: "Novi Corpus asks for no pointer for this order just now, so none is offered.",
    },
    gasEstimating: "Estimating the gas…",
    gasEstimate: "Estimated gas: up to {amount} USDC.",
    gasBalance: "This wallet holds {balance} USDC.",
    gasUnread:
      "The gas could not be estimated just now; your wallet shows its own estimate when it opens.",
    notEnough:
      "That is less than the estimate, so the pointer cannot be sent yet: add a little native USDC to this wallet, then check the balance again; the button turns on once the balance covers the gas.",
    checkBalance: "Check the balance again",
    sendAgain:
      "If the transaction was dropped and never reached the chain, you can send it again: it writes the same pointer, so a second one changes nothing.",
    gasProduction: "Your wallet needs a little native USDC on Arc for gas.",
    seed: "Ask Novi Corpus for a little gas",
    seedSent: "A little native USDC was sent to this wallet.",
    seedNoAnswer: "No answer came back for the gas just now.",
    send: "Write the pointer",
    inWallet: "Waiting for your wallet…",
    waiting:
      "Waiting for the pointer transaction to be confirmed on the chain. This can take up to 3 minutes.",
    confirmed: "The pointer transaction is confirmed on the chain.",
    reverted:
      "The pointer transaction failed on the chain, so the identity does not point at the body. You can send it again.",
    noReceipt:
      "No receipt came back within 3 minutes, so whether the pointer landed is not known yet. Look at the transaction; Novi Corpus is asked to check the pointer either way.",
    refreshing: "Asking Novi Corpus to check the pointer…",
    chainUnreadLine:
      "Novi Corpus {reason}, so this order stays as last read: {state}. The next check tries again.",
    rejected: "Your wallet did not send the pointer, so nothing was written. It said: {message}",
    rejectedNoWords: "Your wallet did not send the pointer, so nothing was written.",
    otherNetwork:
      "Your wallet is on another network than {network}. Switch it there and send again; nothing was sent.",
    otherChain:
      "This site sends to {network} only, and this deployment names another chain, so the pointer cannot be written here.",
    refusedBeforeWallet:
      "The pointer transaction was refused before your wallet opened ({problem}), so nothing was sent.",
    notConnected:
      "This wallet is not connected in this browser just now. Connect it again to write the pointer; nothing was sent.",
  },

  done: {
    yes: YES_SENTENCE,
    notYetVisible: "the record appears within a minute of the pointer being seen",
    notYetPaid: "not yet paid",
    checkNotStanding: "the operator's check is no longer standing",
    chainUnread: "the chain could not be read just now",
    filingFactsMissing: "the filing facts are not recorded",
    anotherAgent: "Get a legal body for another agent",
    anotherCompany: "Declare another company",
    anotherFormed: "Get a company for another agent",
    formedBy: "Formed by Novi Corpus through doola on {date}, filing number {number}.",
    formedByNoNumber: "Formed by Novi Corpus through doola on {date}.",
    /** Counsel has not signed off on this sentence. Shown only once a supplement is recorded. */
    daoSupplement: "A supplement to the articles of this company was recorded on {date}.",
    identityVerified: "Identity of the person in control verified",
    identityDue: "Identity verification due",

    title: "Your agent's legal body",
    intro:
      "What anyone can read about it, without an account: its standing, the facts a counterparty cares about, and the statement to check.",
    /** The two labels that are not one of the API's four standing words. */
    labels: {
      couldNotCheck: "could not check",
      notYetVisible: "not yet visible",
    },
    standingHeading: "Standing",
    reading: "reading the public record",
    notLinked: "the public record is read here only while the identity points at this body",
    /** Why the public read made no answer, one per reason; none of them is a negative. */
    couldNotCheckReasons: {
      rate_limited: "the public record was asked too often just now; try again in a few seconds",
      unavailable: "Novi Corpus could not check just now; try again shortly",
      validation_error: "the public record did not take this agent id",
      network: "the public record could not be reached from this browser",
      timeout: "the public record did not answer in time",
      malformed: "the public record's answer could not be read",
    },
    saysNothing: "this says nothing about the body's standing",
    inactiveWords:
      "the statement says attestationState {attestationState} and bindingState {bindingState}",
    standingNotKnown:
      "the statement gives a standing this page does not know, so it reads as unknown here",
    /** On both doors' done page. */
    sandboxStatement:
      "sandbox: this statement is a test about a test company, and nothing in it is a filing",
    retry: "Try again",
    factsHeading: "What the statement says",
    facts: {
      identity: "Identity",
      body: "Legal body",
      binding: "Binding",
      attestation: "Attestation",
      filingStatus: "Filing status",
      nextDue: "Next annual report due",
      environment: "Environment",
    },
    notRecorded: "not recorded",
    linksHeading: "Links",
    statementLink: "The statement, to give a counterparty",
    transparencyLink: "The transparency page",
    checkHeading: "What a counterparty can check",
    checkIntro:
      "Anyone can open this address without an account and read the signed statement as it stands now.",
    environmentLabel: "environment",
    sayLabel: "What they may say, word for word",
    sayLabelSandbox: "What they may say, with the word sandbox beside it",
    sandboxPill: "sandbox",
    sayAsItIs:
      "Say the standing as it is, {standing}, and nothing more: the yes sentence is said only of an active standing.",
    sayTest: "A sandbox statement is a test: say so, and never present it as a filing.",
    sayWithSandbox:
      "Say it with the word sandbox: a sandbox statement is a test, and nothing in it is a filing.",
  },

  /** "My agents": the account's legal bodies beside its agents with a treasury. */
  account: {
    legalBodies: "Legal bodies",
    treasuryAgents: "Agents with a treasury",
    add: "Add",
    states: { in_progress: "In progress", linked: "Linked", attention: "Needs attention" },
    actions: { continue: "Continue", open: "Open" },
    agent: "agent #{agentId}",
    unreadable: "Your legal bodies could not be read.",
    emptyTitle: "Nothing here yet",
    emptyBody: "Give your agent a legal body.",
    getStarted: "Get started",
    treasuryNone: "No agent with a treasury yet.",
    treasuryUnreadable: "Your agents with a treasury could not be read.",
    /** Beside a linked row's standing, when its record still names the guardian's wallet or none. */
    walletOwed: "Agent's wallet not set",
  },

  transparency: {
    heading: "Legal bodies",
    intro:
      "Legal bodies on customer-owned identities. On Arc testnet these are test declarations, checked automatically, and nothing here is a filing.",
    statTile: "Legal bodies on own identities",
    unavailable: "The legal-body list could not be read just now.",
    empty: "No legal body is linked yet.",
    columns: {
      agentId: "Agent ID",
      legalName: "Legal name",
      filingNumber: "Filing number",
      body: "Body",
      linkedSince: "Linked since",
      environment: "Environment",
      statement: "Statement",
    },
    statementLink: "Statement",
  },
} as const;

/** Why an operator's check failed, one sentence per reason code. The operator's own words are
 *  never served, so these are all a screen can say. */
export const CHECK_REASON_SENTENCES: Record<CheckReasonCode, string> = {
  name_mismatch: "The name on the registry does not match the declared company name.",
  filing_not_found: "The registry has no filing with the declared filing number.",
  not_active: "The registry does not show the company as active.",
  control_not_shown: "The documents do not show that you control the company.",
  other: "The operator could not confirm the declaration.",
};

/** The only sentences allowed to say "verified": each is about the person on record. */
export const PERSON_SENTENCES: readonly string[] = [
  PERSON_ON_RECORD,
  VERIFIED_AS,
  "Verified",
  "Verified on {date}",
  "Identity of the person in control verified",
];

/** The only sentences allowed to say "Novi" without "Corpus". */
export const APPROVED_NOVI_SENTENCES: readonly string[] = [YES_SENTENCE];

/** `template` with each `{name}` replaced by its value. A name with no value stays as written, so
 *  a missing value shows up as a visible mistake rather than a silent gap. */
export function fillCopy(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  );
}
