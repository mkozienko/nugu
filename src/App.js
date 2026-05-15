import React, { useEffect, useMemo, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import "pdfjs-dist/build/pdf.worker";
import { openDB } from "idb";

const DB_NAME = "study-app-db";
const DB_VERSION = 1;
const PDF_STORE = "pdfs";

async function getDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(PDF_STORE)) {
        db.createObjectStore(PDF_STORE);
      }
    },
  });
}

async function savePdfBuffer(pdfId, buffer) {
  const db = await getDb();
  await db.put(PDF_STORE, buffer, pdfId);
}

async function loadPdfBuffer(pdfId) {
  const db = await getDb();
  return db.get(PDF_STORE, pdfId);
}

async function deletePdfBuffer(pdfId) {
  const db = await getDb();
  await db.delete(PDF_STORE, pdfId);
}

async function getStoredPdfIds() {
  const db = await getDb();
  return db.getAllKeys(PDF_STORE);
}

function App() {
  const DATA_VERSION = 13;
  const intervals = {
    "Very Hard": 1,
    Hard: 5,
    Easy: 10,
    "Very Easy": 15,
  };

  const [decks, setDecks] = useState([]);
  const [sessionCards, setSessionCards] = useState([]);
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [mode, setMode] = useState("review");
  const [reviewScope, setReviewScope] = useState("all");
  const [browseFilter, setBrowseFilter] = useState("all");
  const [selectedDeckId, setSelectedDeckId] = useState(null);
  const [now, setNow] = useState(new Date());
  const [loaded, setLoaded] = useState(false);
  const [sessionInitialized, setSessionInitialized] = useState(false);

  const [pdfMap, setPdfMap] = useState({});
  const [annotations, setAnnotations] = useState([]);
  const [readerPdfId, setReaderPdfId] = useState(null);
  const [readerPageNumber, setReaderPageNumber] = useState(1);
  const [readerImage, setReaderImage] = useState(null);
  const [readerPageText, setReaderPageText] = useState("");
  const [readerTool, setReaderTool] = useState("comment");
  const [aiStatus, setAiStatus] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [editingCardId, setEditingCardId] = useState(null);
  const [editingQuestion, setEditingQuestion] = useState("");
  const [editingAnswer, setEditingAnswer] = useState("");
  const [manualQuestion, setManualQuestion] = useState("");
  const [manualAnswer, setManualAnswer] = useState("");
  const [chatGptImportText, setChatGptImportText] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [currentImage, setCurrentImage] = useState(null);
  const [browsePreviewCardId, setBrowsePreviewCardId] = useState(null);
  const [browsePreviewImage, setBrowsePreviewImage] = useState(null);
  const [mediaStatus, setMediaStatus] = useState({
    unusedPdfIds: [],
    missingPdfIds: [],
  });

  const skipPhrases = [
    "overview",
    "learning objectives",
    "educational goal",
    "why is this important",
  ];

  const shuffleArray = (array) => {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const getTitle = (items) => {
    const sorted = [...items].sort((a, b) => (b.height || 0) - (a.height || 0));
    return sorted[0]?.str || "";
  };

  const cleanTitle = (t) => (t || "").replace(/\s+/g, " ").trim();

  const getQuestionTopic = (title, pageNumber) => {
    const topic = cleanTitle(title)
      .replace(/\u2022/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!topic || topic.length > 70) return `page ${pageNumber}`;
    return topic;
  };

  const buildSmartQuestion = (title, text) => {
    const topic = cleanTitle(title) || "this topic";
    const normalizedText = (text || "").toLowerCase();

    if (/challeng|difficult|problem|failure|risk/.test(normalizedText)) {
      return `Why is ${topic} challenging, and which factors make it harder to manage or apply correctly?`;
    }

    if (/treatment|therapy|drug|dose|toxic|resistance/.test(normalizedText)) {
      return `How does ${topic} affect treatment decisions, and what trade-offs or limitations must be considered?`;
    }

    if (/increase|decrease|reduce|prevent|cause|lead/.test(normalizedText)) {
      return `What causes the main changes described in ${topic}, and what are the practical consequences?`;
    }

    if (/compare|versus|different|distinguish|unlike/.test(normalizedText)) {
      return `How would you distinguish the key ideas in ${topic}, and why does that distinction matter?`;
    }

    if (/diagnos|detect|screen|test|early/.test(normalizedText)) {
      return `What should a student understand about ${topic} in order to recognize or detect the problem correctly?`;
    }

    return `Explain the central idea of ${topic}. What must be understood well enough to use it in a real question?`;
  };

  const splitStudyFacts = (text) => {
    const prepared = (text || "")
      .replace(/\u2022/g, "\n")
      .replace(/\s+-\s+/g, "\n")
      .replace(/\n{2,}/g, "\n");

    return prepared
      .split(/\n|;|(?<=[.!?])\s+/)
      .map((fact) => fact.replace(/\s+/g, " ").trim())
      .filter((fact) => fact.length >= 28)
      .filter((fact) => !/^page\s+\d+/i.test(fact));
  };

  const isLikelyHeading = (fact) =>
    fact.length < 80 &&
    !/[.!?]$/.test(fact) &&
    fact.split(/\s+/).length <= 10;

  const trimAnswer = (fact) => {
    if (fact.length <= 240) return fact;
    return `${fact.slice(0, 237).trim()}...`;
  };

  const buildAtomicQuestion = (topic, fact) => {
    const cleanTopic = cleanTitle(topic) || "this page";
    const lower = fact.toLowerCase();

    if (/toxic|toxicity|normal cells?/.test(lower)) {
      return `Why can this treatment harm normal cells?`;
    }

    if (/fractional cell kill|percentage/.test(lower)) {
      return `Why does fractional cell kill require repeated treatment cycles?`;
    }

    if (/fail|failure|detect|early/.test(lower)) {
      return `Why does delayed detection make treatment harder?`;
    }

    if (/resistan|resistance/.test(lower)) {
      return `How does drug resistance limit therapy?`;
    }

    if (/metastasis|spread/.test(lower)) {
      return `Why does metastatic risk make this problem more serious?`;
    }

    if (/deliver|delivery|tumou?r/.test(lower)) {
      return `What delivery problem must therapy solve?`;
    }

    if (/duration|time|schedule|cycle/.test(lower)) {
      return `Why does timing or duration matter here?`;
    }

    if (/increase|decrease|reduce|prevent|cause|lead|risk/.test(lower)) {
      return `What cause-and-effect relationship is being tested?`;
    }

    return `What is the key testable idea about ${cleanTopic}?`;
  };

  const buildAtomicCards = ({ pdfId, pageNumber, title, text }) => {
    const topic = getQuestionTopic(title, pageNumber);
    const facts = splitStudyFacts(text).filter((fact) => !isLikelyHeading(fact));
    const uniqueFacts = [...new Set(facts)].slice(0, 7);

    if (uniqueFacts.length === 0) {
      return [
        {
          id: `${pdfId}-${pageNumber}-auto-0`,
          cardType: "auto",
          question: buildSmartQuestion(topic, text),
          answer: trimAnswer(text),
          pdfId,
          pageNumber,
          nextReviewDate: new Date(Date.now() - 1000).toISOString(),
          lapses: 0,
          isSuspended: false,
        },
      ];
    }

    return uniqueFacts.map((fact, index) => ({
      id: `${pdfId}-${pageNumber}-auto-${index}`,
      cardType: "auto",
      question: buildAtomicQuestion(topic, fact),
      answer: trimAnswer(fact),
      pdfId,
      pageNumber,
      nextReviewDate: new Date(Date.now() - 1000).toISOString(),
      lapses: 0,
      isSuspended: false,
    }));
  };

  const textItemsToReadableText = (items) => {
    const rows = [];

    (items || []).forEach((item) => {
      const value = (item.str || "").trim();
      if (!value) return;

      const y = Math.round(item.transform?.[5] || 0);
      const x = item.transform?.[4] || 0;
      let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 3);

      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }

      row.items.push({ x, value });
    });

    return rows
      .sort((a, b) => b.y - a.y)
      .map((row) =>
        row.items
          .sort((a, b) => a.x - b.x)
          .map((item) => item.value)
          .join(" ")
          .replace(/\s+([,.;:)])/g, "$1")
          .replace(/([(])\s+/g, "$1")
      )
      .join("\n")
      .replace(/\n\s*\u2022\s*/g, "\n- ")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\u2022 ?/g, "\n- ")
      .replace(/\n /g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };

  const shouldSkipPage = (text, pageNumber) => {
    if (pageNumber === 1) return true;
    return skipPhrases.some((phrase) => text.toLowerCase().includes(phrase));
  };

  const normalizeDecks = (savedDecks) =>
    (savedDecks || []).map((deck) => ({
      ...deck,
      cards: (deck.cards || []).map((card) => {
        if (card.cardType) return card;

        const isCloze =
          card.sourceAnnotationId ||
          (card.question || "").includes("_____");

        if (isCloze) {
          return { ...card, cardType: "cloze" };
        }

        const oldTitle = (card.question || "")
          .replace(/^What is\s+/i, "")
          .replace(/\?$/, "");

        return {
          ...card,
          cardType: "auto",
          question: /^What is\s+/i.test(card.question || "")
            ? buildSmartQuestion(oldTitle, card.answer)
            : card.question,
        };
      }),
    }));

  const getModeButtonStyle = (btnMode) => {
    const active =
      btnMode === "review-selected"
        ? mode === "review" && reviewScope === "selected"
        : btnMode === "review"
          ? mode === "review" && reviewScope === "all"
          : mode === btnMode;

    const bgMap = {
      review: "#dbeafe",
      "review-selected": "#dbeafe",
      study: "#dcfce7",
      hidden: "#e5e7eb",
      browse: "#fef3c7",
      files: "#fce7f3",
    };

    return {
      padding: "10px 16px",
      marginRight: "10px",
      borderRadius: "8px",
      border: "1px solid #cbd5e1",
      cursor: "pointer",
      background: active ? bgMap[btnMode] : "#f8fafc",
      boxShadow: active
        ? "inset 2px 2px 6px rgba(0,0,0,0.18)"
        : "2px 2px 6px rgba(0,0,0,0.08)",
      transform: active ? "translateY(1px)" : "none",
      fontWeight: active ? "700" : "500",
    };
  };

  useEffect(() => {
    const loadApp = async () => {
      const saved = localStorage.getItem("decks");
      const version = localStorage.getItem("version");

      if (version !== String(DATA_VERSION)) {
        localStorage.removeItem("decks");
        localStorage.setItem("version", String(DATA_VERSION));

        setDecks([]);
        setSessionCards([]);
        setCurrentCardIndex(0);
        setSelectedDeckId(null);
        setMode("review");
        setSessionInitialized(false);
        setLoaded(true);
        return;
      }

      if (!saved) {
        const savedAnnotations = localStorage.getItem("annotations");
        if (savedAnnotations) {
          setAnnotations(JSON.parse(savedAnnotations));
        }
        setLoaded(true);
        return;
      }

      const parsed = normalizeDecks(JSON.parse(saved));
      const savedAnnotations = localStorage.getItem("annotations");
      setDecks(parsed);
      if (savedAnnotations) {
        setAnnotations(JSON.parse(savedAnnotations));
      }

      if (parsed.length > 0) {
        setSelectedDeckId(parsed[0].id);
      }

      const pdfIds = [
        ...new Set(
          parsed
            .flatMap((deck) => deck.cards || [])
            .map((card) => card.pdfId)
            .filter(Boolean)
        ),
      ];

      const restoredPdfMap = {};

      for (const pdfId of pdfIds) {
        try {
          const buffer = await loadPdfBuffer(pdfId);
          if (!buffer) continue;

          const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
          restoredPdfMap[pdfId] = pdf;
        } catch (err) {
          console.error(`Failed to restore PDF ${pdfId}:`, err);
        }
      }

      setPdfMap(restoredPdfMap);
      setLoaded(true);
    };

    loadApp();
  }, []);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem("decks", JSON.stringify(decks));
    }
  }, [decks, loaded]);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem("annotations", JSON.stringify(annotations));
    }
  }, [annotations, loaded]);

  useEffect(() => {
    const intervalId = setInterval(() => setNow(new Date()), 5000);
    return () => clearInterval(intervalId);
  }, []);

  const allCards = useMemo(
    () =>
      decks
        .flatMap((deck) => deck.cards || [])
        .filter((card) => card.cardType !== "source"),
    [decks]
  );

  const visibleCards = allCards.filter((card) => !card.isSuspended);
  const hiddenCards = allCards.filter((card) => card.isSuspended);

  const dueCards = visibleCards.filter(
    (card) => new Date(card.nextReviewDate) <= now
  );
  const browseCards = useMemo(() => {
    const cardsWithDeckInfo = decks.flatMap((deck) =>
      (deck.cards || []).map((card) => ({
        ...card,
        deckId: deck.id,
        deckName: deck.name,
      }))
    ).filter((card) => !card.isSuspended);

    if (browseFilter === "due") {
      return cardsWithDeckInfo.filter(
        (card) => new Date(card.nextReviewDate) <= now
      );
    }

    if (browseFilter === "weak") {
      return cardsWithDeckInfo.filter((card) => (card.lapses || 0) >= 3);
    }

    return cardsWithDeckInfo;
  }, [browseFilter, decks, now]);

  const selectedDeck = decks.find((deck) => deck.id === selectedDeckId);
  const visibleCardsForSelectedDeck = useMemo(
    () =>
      selectedDeck
        ? (selectedDeck.cards || []).filter((card) => !card.isSuspended)
        : [],
    [selectedDeck]
  );
  const dueCardsForSelectedDeck = useMemo(
    () =>
      selectedDeck
        ? (selectedDeck.cards || []).filter(
            (card) => !card.isSuspended && new Date(card.nextReviewDate) <= now
          )
        : [],
    [selectedDeck, now]
  );
  const usedPdfIds = useMemo(
    () =>
      [
        ...new Set(
          allCards
            .map((card) => card.pdfId)
            .filter(Boolean)
        ),
      ],
    [allCards]
  );

  const scanMedia = async () => {
    const storedPdfIds = await getStoredPdfIds();
    const usedPdfIdSet = new Set(usedPdfIds);
    const storedPdfIdSet = new Set(storedPdfIds);

    const unusedPdfIds = storedPdfIds.filter((pdfId) => !usedPdfIdSet.has(pdfId));
    const missingPdfIds = usedPdfIds.filter((pdfId) => !storedPdfIdSet.has(pdfId));

    return { unusedPdfIds, missingPdfIds };
  };

  useEffect(() => {
    if (!loaded) return;
    if (sessionInitialized) return;

    if (mode === "review") {
      const reviewCards =
        reviewScope === "selected" ? dueCardsForSelectedDeck : dueCards;
      setSessionCards(shuffleArray(reviewCards));
      setCurrentCardIndex(0);
      setShowAnswer(false);
      setSessionInitialized(true);
    }

    if (mode === "study") {
      const studyCards = selectedDeck
        ? selectedDeck.cards.filter((card) => !card.isSuspended)
        : [];

      setSessionCards(studyCards);
      setCurrentCardIndex(0);
      setShowAnswer(false);
      setSessionInitialized(true);
    }

    if (mode === "hidden") {
      setSessionCards(hiddenCards);
      setCurrentCardIndex(0);
      setShowAnswer(false);
      setSessionInitialized(true);
    }

    if (mode === "browse") {
      setSessionCards([]);
      setCurrentCardIndex(0);
      setShowAnswer(false);
      setSessionInitialized(true);
    }

    if (mode === "files") {
      setSessionCards([]);
      setCurrentCardIndex(0);
      setShowAnswer(false);
      setCurrentImage(null);
      setSessionInitialized(true);
    }
  }, [
    mode,
    loaded,
    sessionInitialized,
    selectedDeck,
    hiddenCards,
    dueCards,
    dueCardsForSelectedDeck,
    reviewScope,
  ]);

  useEffect(() => {
    if (!loaded) return;
    if (!sessionInitialized) return;
    if (mode !== "review") return;
    if (reviewScope !== "all") return;

    const newDue = dueCards.filter(
      (card) => !sessionCards.some((sessionCard) => sessionCard.id === card.id)
    );

    if (newDue.length > 0) {
      setSessionCards((prev) => [...prev, ...shuffleArray(newDue)]);
    }
  }, [dueCards, mode, reviewScope, sessionCards, sessionInitialized, loaded]);

  useEffect(() => {
    if (currentCardIndex >= sessionCards.length && sessionCards.length > 0) {
      setCurrentCardIndex(0);
    }
  }, [currentCardIndex, sessionCards]);

  useEffect(() => {
    if (!loaded) return;

    const refreshMediaStatus = async () => {
      const nextStatus = await scanMedia();
      setMediaStatus(nextStatus);
    };

    refreshMediaStatus();
  }, [loaded, usedPdfIds]);

  const currentCard = sessionCards[currentCardIndex];

  useEffect(() => {
    const handleKey = (e) => {
      if (!currentCard) return;

      if (e.code === "Space") {
        e.preventDefault();
        setShowAnswer(true);
      }

      if (!showAnswer) return;

      if (e.key === "1") rateCard("Very Hard");
      if (e.key === "2") rateCard("Hard");
      if (e.key === "3") rateCard("Easy");
      if (e.key === "4") rateCard("Very Easy");
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [currentCard, showAnswer]);

  useEffect(() => {
    const render = async () => {
      if (!currentCard) {
        setCurrentImage(null);
        return;
      }

      const pdf = pdfMap[currentCard.pdfId];
      if (!pdf) {
        setCurrentImage(null);
        return;
      }

      const page = await pdf.getPage(currentCard.pageNumber);
      const viewport = page.getViewport({ scale: 1.2 });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport }).promise;
      setCurrentImage(canvas.toDataURL());
    };

    render();
  }, [currentCard, pdfMap]);

  useEffect(() => {
    const renderBrowsePreview = async () => {
      if (mode !== "browse" || !browsePreviewCardId) {
        setBrowsePreviewImage(null);
        return;
      }

      const previewCard = allCards.find((card) => card.id === browsePreviewCardId);
      if (!previewCard) {
        setBrowsePreviewImage(null);
        return;
      }

      const pdf = pdfMap[previewCard.pdfId];
      if (!pdf) {
        setBrowsePreviewImage(null);
        return;
      }

      const page = await pdf.getPage(previewCard.pageNumber);
      const viewport = page.getViewport({ scale: 0.45 });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport }).promise;
      setBrowsePreviewImage(canvas.toDataURL());
    };

    renderBrowsePreview();
  }, [allCards, browsePreviewCardId, mode, pdfMap]);

  useEffect(() => {
    const renderReaderPage = async () => {
      if (mode !== "files" || !readerPdfId) {
        setReaderImage(null);
        setReaderPageText("");
        return;
      }

      const pdf = pdfMap[readerPdfId];
      if (!pdf) {
        setReaderImage(null);
        setReaderPageText("");
        return;
      }

      const safePageNumber = Math.min(Math.max(readerPageNumber, 1), pdf.numPages);
      if (safePageNumber !== readerPageNumber) {
        setReaderPageNumber(safePageNumber);
        return;
      }

      const page = await pdf.getPage(safePageNumber);
      const viewport = page.getViewport({ scale: 1.25 });
      const textContent = await page.getTextContent();
      const pageText = textItemsToReadableText(textContent.items);

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport }).promise;
      setReaderImage(canvas.toDataURL());
      setReaderPageText(pageText);
    };

    renderReaderPage();
  }, [mode, pdfMap, readerPageNumber, readerPdfId]);

  const renderPdfPageForAi = async (pdf, pageNumber) => {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 0.85 });
    const textContent = await page.getTextContent();
    const items = textContent.items || [];
    const text = textItemsToReadableText(items);
    const title = cleanTitle(getTitle(items));
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport }).promise;

    return {
      imageDataUrl: canvas.toDataURL("image/jpeg", 0.72),
      pageText: text,
      title,
    };
  };

  const checkAiServer = async () => {
    try {
      const response = await fetch("http://localhost:8787/api/health");
      const data = await response.json();
      if (!data.hasApiKey) {
        throw new Error(
          "AI server is running, but OPENAI_API_KEY is not set. Restart ai-server with your OpenAI API key."
        );
      }
    } catch (error) {
      if (error.message.includes("OPENAI_API_KEY")) throw error;
      throw new Error(
        "Cannot reach AI server at http://localhost:8787. Start it with: npm run ai-server"
      );
    }
  };

  const requestAiCards = async ({
    fileName,
    pdfId,
    pageNumber,
    pageText,
    imageDataUrl,
    pages,
    task,
  }) => {
    const pageAnnotations = annotations.filter(
      (annotation) =>
        annotation.pdfId === pdfId && annotation.pageNumber === pageNumber
    );
    let response;
    try {
      response = await fetch("http://localhost:8787/api/generate-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName,
          task,
          pageNumber,
          pageText,
          imageDataUrl,
          pages,
          comments: pageAnnotations
            .filter((annotation) => annotation.type === "comment")
            .map((annotation) => annotation.text),
          highlights: pageAnnotations
            .filter((annotation) => annotation.type === "highlight")
            .map((annotation) => annotation.text),
        }),
      });
    } catch (error) {
      throw new Error(
        "Failed to reach AI server during generation. The file may be too large or the AI server stopped. Try a smaller page range or restart npm run ai-server."
      );
    }

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "AI generation failed");
    }

    return data.cards || [];
  };

  const toStudyCards = ({ cards, pdfId, pageNumber, idPrefix }) =>
    cards
      .filter((card) => card.question && card.answer)
      .map((card, index) => ({
        id: `${idPrefix}-${index}`,
        cardType: card.cardType === "cloze" ? "cloze" : "ai",
        question: card.question,
        answer: card.answer,
        pdfId,
        pageNumber: card.pageNumber || pageNumber,
        sourceText: card.sourceText || "",
        aiReason: card.reason || "",
        nextReviewDate: new Date(Date.now() - 1000).toISOString(),
        lapses: card.priority === "high" ? 2 : 0,
        priority: card.priority === "high" ? "high" : "normal",
        isSuspended: false,
      }));

  const chunkArray = (items, size) => {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const originalBuffer = await file.arrayBuffer();
    const bufferForPdf = originalBuffer.slice(0);
    const bufferForStorage = originalBuffer.slice(0);
    const pdfId = Date.now();
    const pdf = await pdfjsLib.getDocument({ data: bufferForPdf }).promise;

    await savePdfBuffer(pdfId, bufferForStorage);

    setPdfMap((prev) => ({ ...prev, [pdfId]: pdf }));

    const newDeck = {
      id: Date.now(),
      name: file.name,
      pdfId,
      cards: [
        {
          id: `${pdfId}-source`,
          cardType: "source",
          question: file.name,
          answer: "",
          pdfId,
          pageNumber: 1,
          nextReviewDate: new Date(Date.now() - 1000).toISOString(),
          lapses: 0,
          isSuspended: true,
        },
      ],
    };

    setDecks((prev) => [...prev, newDeck]);
    setSelectedDeckId(newDeck.id);
    setSessionInitialized(false);
    setSessionCards([]);
    setCurrentCardIndex(0);
    setShowAnswer(false);
    setMode("files");
    e.target.value = "";
  };

  const startMode = (newMode) => {
    setSessionInitialized(false);
    setSessionCards([]);
    setCurrentCardIndex(0);
    setShowAnswer(false);
    setBrowsePreviewCardId(null);
    setBrowsePreviewImage(null);
    setMode(newMode);
  };

  const rateCard = (rating) => {
    if (!currentCard) return;

    const next = new Date();
    const intervalMinutes =
      currentCard.priority === "high" && (currentCard.reviewsDone || 0) < 2
        ? Math.max(1, Math.floor(intervals[rating] / 2))
        : intervals[rating];
    next.setMinutes(next.getMinutes() + intervalMinutes);

    if (mode === "review") {
      setDecks((prev) =>
        prev.map((deck) => ({
          ...deck,
          cards: deck.cards.map((card) =>
            card.id === currentCard.id
              ? {
                  ...card,
                  nextReviewDate: next.toISOString(),
                  reviewsDone: (card.reviewsDone || 0) + 1,
                  lapses:
                    rating === "Very Hard"
                      ? (card.lapses || 0) + 1
                      : card.lapses || 0,
                }
              : card
          ),
        }))
      );
    }

    setSessionCards((prev) => prev.filter((card) => card.id !== currentCard.id));
    setShowAnswer(false);
    setCurrentCardIndex(0);
  };

  const hideCard = () => {
    if (!currentCard) return;

    setDecks((prev) =>
      prev.map((deck) => ({
        ...deck,
        cards: deck.cards.map((card) =>
          card.id === currentCard.id ? { ...card, isSuspended: true } : card
        ),
      }))
    );

    setSessionCards((prev) => prev.filter((card) => card.id !== currentCard.id));
    setShowAnswer(false);
    setCurrentCardIndex(0);
  };

  const restoreCard = () => {
    if (!currentCard) return;

    setDecks((prev) =>
      prev.map((deck) => ({
        ...deck,
        cards: deck.cards.map((card) =>
          card.id === currentCard.id ? { ...card, isSuspended: false } : card
        ),
      }))
    );

    setSessionCards((prev) => prev.filter((card) => card.id !== currentCard.id));
    setShowAnswer(false);
    setCurrentCardIndex(0);
  };

  const deleteDeck = (deckId) => {
    const deckToDelete = decks.find((deck) => deck.id === deckId);
    if (!deckToDelete) return;

    const nextDecks = decks.filter((deck) => deck.id !== deckId);

    setDecks(nextDecks);

    if (selectedDeckId === deckId) {
      setSelectedDeckId(nextDecks[0]?.id ?? null);
    }

    setSessionInitialized(false);
    setSessionCards([]);
    setCurrentCardIndex(0);
    setShowAnswer(false);
    setCurrentImage(null);
  };

  const deleteCard = (cardId) => {
    setDecks((prev) =>
      prev
        .map((deck) => ({
          ...deck,
          cards: deck.cards.filter((card) => card.id !== cardId),
        }))
        .filter((deck) => deck.cards.length > 0)
    );

    setSessionInitialized(false);
    setSessionCards((prev) => prev.filter((card) => card.id !== cardId));
    setCurrentCardIndex(0);
    setShowAnswer(false);
    setCurrentImage(null);
  };

  const openCardInReview = (cardId) => {
    const targetCard = allCards.find((card) => card.id === cardId);
    if (!targetCard) return;

    setMode("review");
    setSessionCards([targetCard]);
    setCurrentCardIndex(0);
    setShowAnswer(false);
    setSessionInitialized(true);
  };

  const toggleBrowsePreview = (cardId) => {
    if (browsePreviewCardId === cardId) {
      setBrowsePreviewCardId(null);
      setBrowsePreviewImage(null);
      return;
    }

    setBrowsePreviewCardId(cardId);
    setBrowsePreviewImage(null);
  };

  const cleanUnusedFiles = async () => {
    const { unusedPdfIds, missingPdfIds } = await scanMedia();

    for (const pdfId of unusedPdfIds) {
      await deletePdfBuffer(pdfId);
    }

    if (unusedPdfIds.length > 0) {
      setPdfMap((prev) => {
        const nextMap = { ...prev };
        unusedPdfIds.forEach((pdfId) => {
          delete nextMap[pdfId];
        });
        return nextMap;
      });
    }

    setMediaStatus({
      unusedPdfIds: [],
      missingPdfIds,
    });
  };

  const openDeckInReader = (deck) => {
    const pdfId = deck.cards.find((card) => card.pdfId)?.pdfId || deck.pdfId;
    if (!pdfId) return;

    setReaderPdfId(pdfId);
    setReaderPageNumber(1);
    setReaderImage(null);
    setReaderPageText("");
    startMode("files");
  };

  const generateAiCardsForPage = async () => {
    if (!readerPdfId || !readerPdf) return;

    setAiBusy(true);
    setAiStatus(`AI is reading page ${readerPageNumber}...`);

    try {
      await checkAiServer();
      const pagePayload = readerImage
        ? {
            imageDataUrl: readerImage,
            pageText: readerPageText,
          }
        : await renderPdfPageForAi(readerPdf, readerPageNumber);
      const cards = await requestAiCards({
        fileName: readerDeck?.name || "PDF",
        pdfId: readerPdfId,
        pageNumber: readerPageNumber,
        pageText: pagePayload.pageText,
        imageDataUrl: pagePayload.imageDataUrl,
      });
      const nextCards = toStudyCards({
        cards,
        pdfId: readerPdfId,
        pageNumber: readerPageNumber,
        idPrefix: `${readerPdfId}-${readerPageNumber}-ai-${Date.now()}`,
      });

      setDecks((prev) =>
        prev.map((deck) =>
          deck.id === readerDeck?.id
            ? {
                ...deck,
                cards: [
                  ...deck.cards.filter(
                    (card) =>
                      !(
                        card.pdfId === readerPdfId &&
                        card.pageNumber === readerPageNumber &&
                        card.cardType !== "cloze"
                      )
                  ),
                  ...nextCards,
                ],
              }
            : deck
        )
      );
      setSessionInitialized(false);
      setAiStatus(`AI created ${nextCards.length} cards for page ${readerPageNumber}.`);
      window.alert(`AI created ${nextCards.length} cards for page ${readerPageNumber}.`);
    } catch (error) {
      const message =
        error.message === "OPENAI_API_KEY is not set"
          ? "AI server is running, but OPENAI_API_KEY is not set. Restart ai-server with your OpenAI API key."
          : error.message;
      setAiStatus(message);
      window.alert(message);
    } finally {
      setAiBusy(false);
    }
  };

  const generateAiCardsForDeck = async (deck) => {
    const pdfId = deck.cards.find((card) => card.pdfId)?.pdfId || deck.pdfId;
    const pdf = pdfId ? pdfMap[pdfId] : null;
    if (!pdf) {
      setAiStatus("PDF file is not loaded in this browser session. Reopen or reload the file.");
      return;
    }

    setAiBusy(true);
    setAiStatus("AI is reading the file...");

    try {
      await checkAiServer();
      const clozeCards = (deck.cards || []).filter(
        (card) => card.cardType === "cloze"
      );
      const pages = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const pagePayload = await renderPdfPageForAi(pdf, pageNumber);
        const pageAnnotations = annotations.filter(
          (annotation) =>
            annotation.pdfId === pdfId && annotation.pageNumber === pageNumber
        );

        setAiStatus(`Preparing page ${pageNumber} / ${pdf.numPages} for AI...`);
        pages.push({
          pageNumber,
          pageText: pagePayload.pageText,
          imageDataUrl: pagePayload.imageDataUrl,
          comments: pageAnnotations
            .filter((annotation) => annotation.type === "comment")
            .map((annotation) => annotation.text),
          highlights: pageAnnotations
            .filter((annotation) => annotation.type === "highlight")
            .map((annotation) => annotation.text),
        });
      }

      const pageBatches = chunkArray(pages, 3);
      const generatedCards = [];

      for (let batchIndex = 0; batchIndex < pageBatches.length; batchIndex++) {
        const batch = pageBatches[batchIndex];
        const firstPage = batch[0]?.pageNumber;
        const lastPage = batch[batch.length - 1]?.pageNumber;
        setAiStatus(
          `AI is analyzing pages ${firstPage}-${lastPage} (${batchIndex + 1} / ${pageBatches.length})...`
        );

        const cards = await requestAiCards({
          fileName: deck.name,
          pdfId,
          pages: batch,
          task:
            "Analyze this page batch as part of one coherent PDF lesson. Generate only meaningful Anki cards from this batch. Use highlights as cloze cards. Skip intro/overview/example-only/decorative/source-only material. Avoid duplicate cards if a page only supports a concept explained elsewhere.",
        });

        generatedCards.push(
          ...toStudyCards({
            cards,
            pdfId,
            pageNumber: firstPage || 1,
            idPrefix: `${pdfId}-ai-file-${Date.now()}-${batchIndex}`,
          })
        );
      }

      setDecks((prev) =>
        prev.map((currentDeck) =>
          currentDeck.id === deck.id
            ? { ...currentDeck, cards: [...generatedCards, ...clozeCards] }
            : currentDeck
        )
      );
      setSessionInitialized(false);
      setSessionCards([]);
      setCurrentCardIndex(0);
      setShowAnswer(false);
      setAiStatus(`AI created ${generatedCards.length} cards for ${deck.name}.`);
      window.alert(`AI created ${generatedCards.length} cards for ${deck.name}.`);
    } catch (error) {
      const message =
        error.message === "OPENAI_API_KEY is not set"
          ? "AI server is running, but OPENAI_API_KEY is not set. Restart ai-server with your OpenAI API key."
          : error.message;
      setAiStatus(message);
      window.alert(message);
    } finally {
      setAiBusy(false);
    }
  };

  const addReaderComment = (event) => {
    if (readerTool !== "comment" || !readerPdfId) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const text = window.prompt("Comment for this place");
    if (!text?.trim()) return;

    setAnnotations((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "comment",
        pdfId: readerPdfId,
        pageNumber: readerPageNumber,
        x,
        y,
        text: text.trim(),
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const addSelectedTextHighlight = () => {
    if (!readerPdfId) return;

    const selectedText = window.getSelection().toString().replace(/\s+/g, " ").trim();
    if (!selectedText) {
      window.alert("Select text in the Page text panel first.");
      return;
    }

    setAnnotations((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "highlight",
        pdfId: readerPdfId,
        pageNumber: readerPageNumber,
        text: selectedText,
        color: "#fde68a",
        createdAt: new Date().toISOString(),
      },
    ]);

    window.getSelection().removeAllRanges();
  };

  const deleteAnnotation = (annotationId) => {
    setAnnotations((prev) =>
      prev.filter((annotation) => annotation.id !== annotationId)
    );
  };

  const startEditCard = (card) => {
    setEditingCardId(card.id);
    setEditingQuestion(card.question || "");
    setEditingAnswer(card.answer || "");
  };

  const cancelEditCard = () => {
    setEditingCardId(null);
    setEditingQuestion("");
    setEditingAnswer("");
  };

  const saveEditedCard = (cardId) => {
    setDecks((prev) =>
      prev.map((deck) => ({
        ...deck,
        cards: (deck.cards || []).map((card) =>
          card.id === cardId
            ? {
                ...card,
                question: editingQuestion.trim(),
                answer: editingAnswer.trim(),
              }
            : card
        ),
      }))
    );
    setSessionCards((prev) =>
      prev.map((card) =>
        card.id === cardId
          ? {
              ...card,
              question: editingQuestion.trim(),
              answer: editingAnswer.trim(),
            }
          : card
      )
    );
    cancelEditCard();
  };

  const deleteStudyCard = (cardId) => {
    setDecks((prev) =>
      prev.map((deck) => ({
        ...deck,
        cards: (deck.cards || []).filter((card) => card.id !== cardId),
      }))
    );
    setSessionCards((prev) => prev.filter((card) => card.id !== cardId));
    if (editingCardId === cardId) {
      cancelEditCard();
    }
  };

  const goToCardPage = (card) => {
    setReaderPdfId(card.pdfId);
    setReaderPageNumber(card.pageNumber || 1);
    setReaderImage(null);
    setReaderPageText("");
    startMode("files");
  };

  const buildChatGptPromptForPage = () => {
    const comments = readerPageAnnotations
      .filter((annotation) => annotation.type === "comment")
      .map((annotation) => annotation.text);
    const highlights = readerPageAnnotations
      .filter((annotation) => annotation.type === "highlight")
      .map((annotation) => annotation.text);

    return `Create high-quality Anki cards from this PDF page.

Rules:
- First identify the main topic/subtopic of this page. Act as an expert educator in that field when deciding what is worth testing.
- Use expertise only to choose and phrase questions; do not use outside knowledge in answers.
- Use the page image/layout if I attach a screenshot.
- Do not create cards from URLs, citations, page numbers, decorative images, or example-only photos.
- Skip intro/overview/general explanation unless it contains a key criterion.
- If the page is a comparison table, compress bullets into category-level cards. Usually create one card per category or one comparison card, not one card per bullet.
- One card should test one meaningful idea.
- Prefer mechanism, clinical recognition, contrast, consequence, diagnostic criteria, and treatment decisions.
- Apply discipline-specific judgment after identifying the topic:
  - Medicine/clinical: prioritize diagnosis, distinguishing features, red flags, mechanisms, complications, treatment decisions, contraindications, and monitoring.
  - Pharmacology: prioritize mechanism of action, adverse effects, drug interactions, contraindications, toxicity, monitoring, timing, and high-yield drug/class contrasts.
  - Pathology: prioritize pathogenesis, morphology, clinical correlations, staging/grading, complications, and distinguishing findings.
  - Immunology/microbiology: prioritize immune mechanisms, organism/host interactions, virulence, diagnostic clues, prevention, and treatment logic.
  - Anatomy/physiology: prioritize structure-function relationships, pathways, regulation, lesion effects, and clinically relevant correlations.
  - Math/statistics/research methods: prioritize assumptions, formulas, interpretation, rates, edge cases, failure conditions, and when a method applies.
  - General science: prioritize mechanisms, causal chains, comparisons, experimental logic, and consequences.
- If highlights are provided, create cloze cards using _____ for the highlighted text.
- Create no more than 8 cards for this page unless it clearly contains several independently testable concepts.
- Questions may be AI-generated, but answers must contain ONLY text explicitly present in the PDF or screenshot.
- Do NOT add outside knowledge, explain in your own words, summarize, use references/citations as answers, or infer unstated information in answers.
- If the PDF/screenshot does not explicitly contain the answer, do not create the card.
- Preserve the page number accurately.
- Return cards in this format:
Q:
A:
Type: ai or cloze
Priority: normal or high

File: ${readerDeck?.name || "PDF"}
Page: ${readerPageNumber}

Comments:
${comments.length ? comments.map((item) => `- ${item}`).join("\n") : "None"}

Highlights:
${highlights.length ? highlights.map((item) => `- ${item}`).join("\n") : "None"}

Raw PDF text:
${readerPageText || "No extracted text. Use the attached screenshot if available."}
`;
  };

  const copyPromptForChatGpt = async () => {
    const prompt = buildChatGptPromptForPage();
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyStatus("Prompt copied. Paste it into ChatGPT with this page screenshot if needed.");
    } catch (error) {
      setCopyStatus("Could not copy automatically. Select and copy the prompt manually.");
      window.prompt("Copy this prompt", prompt);
    }
  };

  const buildChatGptPromptForFile = () => {
    const fileAnnotations = annotations.filter(
      (annotation) => annotation.pdfId === readerPdfId
    );
    const comments = fileAnnotations.filter(
      (annotation) => annotation.type === "comment"
    );
    const highlights = fileAnnotations.filter(
      (annotation) => annotation.type === "highlight"
    );

    return `I attached a PDF lecture/file. Create high-quality Anki-style cards from the whole file.

Important goal:
Create useful study cards, not a summary. Quality is more important than quantity.

GLOBAL PRINCIPLES:
- Analyze the PDF as one coherent lesson.
- Identify the main topic and subtopics before generating cards.
- Act as an expert educator when deciding what is worth testing.
- Use domain expertise ONLY to:
  - identify important concepts
  - decide what is worth testing
  - phrase strong recall questions
- Do NOT use domain expertise to expand, reinterpret, complete, simplify, or improve answers.

CARD DESIGN RULES:
- One card should test one meaningful idea.
- Prefer active recall over recognition.
- Prefer recall-based questions over recognition-based questions.
- The learner should usually need to actively retrieve information, not merely recognize it.
- A good card should remain challenging even after repeated reviews.
- Avoid cards solvable through wording cues alone.
- Prefer cards based on:
  - mechanisms
  - causal chains
  - comparisons
  - contrasts
  - consequences
  - assumptions
  - interpretation
  - edge cases
  - failure conditions
  - diagnostic logic
  - treatment decisions
  - classification logic
  - sequencing logic
  - rates and asymptotics
  - when/why a method applies
- Prefer interpretation cards, reasoning cards, contrast cards, differentiation cards, and sequencing cards over pure terminology cards, acronym-expansion cards, isolated fact recall, and vague definition cards.
- Avoid shallow cards like:
  - "What is the key idea?"
  - "Explain this page."
  - vague summary prompts
- Avoid giant symptom-list cards, trivia cards, row-memorization cards, isolated statistics memorization, isolated brand-name memorization, low-value dosage memorization, duplicate cards, huge answers, and redundant cards testing the same concept repeatedly.
- Avoid huge answers.
- Keep answers concise but complete.
- Avoid redundant cards testing the same fact repeatedly.
- A strong card should still be meaningful even if the learner has forgotten the exact page layout.
- Avoid creating cards whose answers are single isolated symbols, variable names, or notation unless the notation itself is educationally important.

LOW-YIELD FILTERING RULES:
- Avoid broad list-recall cards when the list is long.
- Instead, split into clinically or conceptually meaningful distinctions and test dangerous findings, differentiating findings, mechanisms, relationships between concepts, treatment logic, or causal logic.
- Avoid trivia-style cards.
- Avoid cards based only on isolated statistics, percentages, dates, rankings, or epidemiology unless repeatedly emphasized, clinically actionable, or central to the lecture.
- Avoid isolated brand-name memorization cards unless strongly emphasized.
- Avoid low-value dosage memorization cards unless clinically dangerous, repeatedly emphasized, or changing treatment decisions.
- Prefer focused cards testing distinguishing findings, dangerous findings, escalation triggers, mechanism, and treatment implications.
- If multiple pages repeat the same teaching point with only wording differences, create a single stronger consolidated card and avoid near-duplicate cards.

DISCIPLINE-SPECIFIC PRIORITIES:

Medicine/clinical:
- prioritize diagnosis
- distinguishing findings
- red flags
- mechanisms
- complications
- contraindications
- monitoring
- treatment decisions
- escalation logic
- pattern recognition
- Prefer cards testing distinctions within a hierarchy instead of broad parent-category definitions when the lecture provides subclass differentiation.

Pharmacology:
- prioritize mechanism of action
- adverse effects
- interactions
- contraindications
- toxicity
- timing
- resistance
- monitoring
- drug/class contrasts
- treatment role
- avoid isolated drug-name recall unless strongly emphasized
- Avoid overly broad mechanism questions.
- Mechanism cards should test specific pathways, causal effects, resistance mechanisms, toxicity mechanisms, and therapeutic consequences.

Pathology:
- prioritize pathogenesis
- morphology
- staging/grading
- complications
- clinical correlations

Immunology/microbiology:
- prioritize immune mechanisms
- virulence
- organism-host interactions
- diagnostic clues
- prevention
- treatment logic

Anatomy/physiology:
- prioritize structure-function relationships
- pathways
- regulation
- lesion effects
- clinically relevant correlations

Math/statistics/research methods:
- prioritize:
  - assumptions
  - formulas
  - interpretation
  - rates
  - asymptotic conditions
  - edge cases
  - failure conditions
  - when a method applies
- test understanding, not formula memorization alone
- For formulas, prioritize interpretation, assumptions, asymptotic meaning, parameter effects, what increases/decreases, and why the result matters.
- Avoid cards that only reproduce long equations unless the equation itself is explicitly emphasized.

General science:
- prioritize mechanisms
- comparisons
- experimental logic
- consequences
- causal chains

TABLE / CLASSIFICATION RULES:
- When using tables, prioritize clinically or conceptually meaningful contrasts.
- Avoid generating one card per row unless rows represent truly distinct high-yield entities.
- Prefer conceptual contrasts over exhaustive coverage.
- Avoid cards whose only purpose is row memorization.
- Prioritize differences affecting diagnosis, treatment, toxicity, prognosis, or mechanism.
- When multiple therapies, stages, classifications, or categories are presented together, prefer comparison cards, sequencing cards, and contrast cards.
- Avoid isolated definition cards whenever possible.

PDF FILTERING RULES:
- Skip:
  - intro pages
  - agenda
  - learning objectives
  - motivational text
  - URL/reference-only content
  - decorative/example-only images
- Do NOT skip diagrams/tables/images automatically.
- Use images only if they add independently testable meaning.
- Images should support recognition of clinically meaningful patterns, labeled structures, lesion morphology, or diagnostic distinctions.
- Do NOT create cards based solely on generic visual appearance.
- Do NOT infer unlabeled visual findings from images.
- Only create image-based cards if the feature is explicitly labeled or clearly explained in nearby text.
- If a page only supports a prior concept visually without adding new testable information, skip it.
- If a page is a comparison table:
  - compress into category-level cards
  - avoid one card per bullet point

PATIENT CASE RULES:
- For patient cases, create cards only if the answer is explicitly supported by the lecture.
- Do NOT generate independent clinical reasoning beyond the lecture.
- Prefer recognition of patterns taught in the lecture, distinguishing features, and treatment implications.

CLOZE RULES:
- If highlighted/annotated concepts exist, create cloze cards.
- Use _____ for omitted concepts.
- Cloze cards should still test meaningful understanding, not trivial fill-in-the-blank.

ANSWER GROUNDING RULES (CRITICAL):
- Questions may be AI-generated.
- Answers must be extractive, not generative.
- Answers must contain ONLY information explicitly present in the PDF.
- Prefer exact or minimally trimmed spans copied directly from the PDF.
- Answers should stay максимально close to the original PDF wording.

Do NOT:
- paraphrase
- rewrite
- summarize
- simplify using outside knowledge
- combine information from unrelated sections
- infer unstated conclusions
- "improve" explanations
- add textbook knowledge not explicitly present

If the PDF does not explicitly support the answer:
- DO NOT create the card.

GROUNDING / SOURCE RULES:
- The "sourceText" field must contain the exact supporting snippet copied from the PDF.
- Ground truth is the PDF, not the model.
- Prefer answers supported by a single local section/page whenever possible.
- Do NOT create cards requiring synthesis across distant pages unless the PDF explicitly combines those ideas.

CARD QUALITY RULES:
- Prefer fewer strong cards over many weak cards.
- Create no more than 60 cards unless the document clearly requires more.
- Prioritize high-yield concepts, repeated concepts, emphasized concepts, and foundational concepts.

RETURN FORMAT:
Return ONLY valid JSON in this exact structure:

{
  "cards": [
    {
      "pageNumber": 7,
      "question": "question text",
      "answer": "answer text",
      "cardType": "ai",
      "priority": "normal",
      "sourceText": "exact supporting snippet copied from PDF",
      "reason": "why this card is useful"
    }
  ]
}

FIELD RULES:
- pageNumber:
  preserve the original PDF page as accurately as possible

- question:
  concise, specific, active-recall focused

- answer:
  grounded strictly in PDF text

- cardType:
  use:
    - "ai" for normal cards
    - "cloze" for cloze deletion cards

- priority:
  use:
    - "high" only for truly foundational, repeated, emphasized, clinically critical, or strongly testable concepts
    - otherwise use "normal"

- sourceText:
  exact supporting text span copied from PDF

- reason:
  short explanation of why this card is educationally useful

File name:
${readerDeck?.name || "PDF"}

My comments:
${
  comments.length
    ? comments
        .map((annotation) => `- Page ${annotation.pageNumber}: ${annotation.text}`)
        .join("\n")
    : "None"
}

My highlights:
${
  highlights.length
    ? highlights
        .map((annotation) => `- Page ${annotation.pageNumber}: ${annotation.text}`)
        .join("\n")
    : "None"
}
`;
  };

  const copyFilePromptForChatGpt = async () => {
    const prompt = buildChatGptPromptForFile();
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyStatus("Whole-file prompt copied. Attach the PDF in ChatGPT, paste the prompt, then import the JSON here.");
    } catch (error) {
      setCopyStatus("Could not copy automatically. Select and copy the prompt manually.");
      window.prompt("Copy this prompt", prompt);
    }
  };

  const createManualCard = () => {
    if (!readerDeck || !readerPdfId) return;
    if (!manualQuestion.trim() || !manualAnswer.trim()) {
      window.alert("Add both question and answer.");
      return;
    }

    const newCard = {
      id: `${readerPdfId}-${readerPageNumber}-manual-${Date.now()}`,
      cardType: "manual",
      question: manualQuestion.trim(),
      answer: manualAnswer.trim(),
      pdfId: readerPdfId,
      pageNumber: readerPageNumber,
      nextReviewDate: new Date(Date.now() - 1000).toISOString(),
      lapses: 0,
      priority: "normal",
      isSuspended: false,
    };

    setDecks((prev) =>
      prev.map((deck) =>
        deck.id === readerDeck.id
          ? { ...deck, cards: [...(deck.cards || []), newCard] }
          : deck
      )
    );
    setManualQuestion("");
    setManualAnswer("");
  };

  const parseChatGptCardsJson = (value) => {
    const cleaned = (value || "")
      .replace(/```json/gi, "```")
      .replace(/```/g, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (firstError) {
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      }

      const firstBracket = cleaned.indexOf("[");
      const lastBracket = cleaned.lastIndexOf("]");
      if (firstBracket !== -1 && lastBracket > firstBracket) {
        return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
      }

      throw firstError;
    }
  };

  const importCardsFromChatGpt = () => {
    if (!readerDeck || !readerPdfId) return;

    try {
      const parsed = parseChatGptCardsJson(chatGptImportText);
      const importedCards = Array.isArray(parsed) ? parsed : parsed.cards;

      if (!Array.isArray(importedCards)) {
        throw new Error("JSON must contain a cards array.");
      }

      const nextCards = importedCards
        .filter((card) => card.question && card.answer)
        .map((card, index) => ({
          id: `${readerPdfId}-chatgpt-${Date.now()}-${index}`,
          cardType: card.cardType === "cloze" ? "cloze" : "ai",
          question: String(card.question).trim(),
          answer: String(card.answer).trim(),
          pdfId: readerPdfId,
          pageNumber: Number(card.pageNumber) || 1,
          sourceText: card.sourceText ? String(card.sourceText) : "",
          aiReason: card.reason ? String(card.reason) : "",
          nextReviewDate: new Date(Date.now() - 1000).toISOString(),
          lapses: card.priority === "high" ? 2 : 0,
          priority: card.priority === "high" ? "high" : "normal",
          isSuspended: false,
        }));

      if (nextCards.length === 0) {
        throw new Error("No valid cards found.");
      }

      setDecks((prev) =>
        prev.map((deck) =>
          deck.id === readerDeck.id
            ? {
                ...deck,
                cards: [
                  ...(deck.cards || []).filter((card) => card.cardType === "source"),
                  ...nextCards,
                ],
              }
            : deck
        )
      );
      setChatGptImportText("");
      setCopyStatus(`Imported ${nextCards.length} cards from ChatGPT.`);
      window.alert(`Imported ${nextCards.length} cards from ChatGPT.`);
    } catch (error) {
      window.alert(`Could not import cards: ${error.message}`);
    }
  };

  const createClozeCardFromHighlight = (annotation) => {
    const targetDeck = decks.find((deck) =>
      (deck.cards || []).some((card) => card.pdfId === annotation.pdfId)
    );
    if (!targetDeck) return;

    const pageComments = annotations.filter(
      (item) =>
        item.type === "comment" &&
        item.pdfId === annotation.pdfId &&
        item.pageNumber === annotation.pageNumber
    );
    const isImportant = pageComments.some((comment) =>
      /important|exam|high yield|must know|важно|экзамен/i.test(comment.text)
    );
    const clozeText = readerPageText.replace(annotation.text, "_____");

    const newCard = {
      id: `${annotation.id}-card`,
      cardType: "cloze",
      sourceAnnotationId: annotation.id,
      question:
        clozeText || `Fill in the blank on page ${annotation.pageNumber}`,
      answer: annotation.text,
      pdfId: annotation.pdfId,
      pageNumber: annotation.pageNumber,
      nextReviewDate: new Date(Date.now() - 1000).toISOString(),
      lapses: isImportant ? 2 : 0,
      priority: isImportant ? "high" : "normal",
      isSuspended: false,
    };

    setDecks((prev) =>
      prev.map((deck) =>
        deck.id === targetDeck.id
          ? {
              ...deck,
              cards: [
                ...deck.cards.filter(
                  (card) =>
                    !(
                      card.pdfId === annotation.pdfId &&
                      card.pageNumber === annotation.pageNumber &&
                      card.cardType !== "cloze"
                    ) && card.sourceAnnotationId !== annotation.id
                ),
                newCard,
              ],
            }
          : deck
      )
    );
    setSessionCards((prev) =>
      prev.filter(
        (card) =>
          !(
            card.pdfId === annotation.pdfId &&
            card.pageNumber === annotation.pageNumber &&
            card.cardType !== "cloze"
          ) && card.sourceAnnotationId !== annotation.id
      )
    );
  };

  const selectDeckForCurrentMode = (deckId) => {
    setSelectedDeckId(deckId);

    if (mode === "study" || (mode === "review" && reviewScope === "selected")) {
      setSessionInitialized(false);
      setSessionCards([]);
      setCurrentCardIndex(0);
      setShowAnswer(false);
      setCurrentImage(null);
    }
  };

  const selectedDeckName = selectedDeck ? selectedDeck.name : "None";
  const readerDeck = decks.find((deck) =>
    (deck.cards || []).some((card) => card.pdfId === readerPdfId)
  );
  const readerPdf = readerPdfId ? pdfMap[readerPdfId] : null;
  const readerFileCards = readerDeck
    ? (readerDeck.cards || []).filter((card) => card.cardType !== "source")
    : [];
  const readerPageCards = readerFileCards.filter(
    (card) => card.pageNumber === readerPageNumber
  );
  const readerPageAnnotations = annotations.filter(
    (annotation) =>
      annotation.pdfId === readerPdfId &&
      annotation.pageNumber === readerPageNumber
  );
  const readerClozeText = readerPageAnnotations
    .filter((annotation) => annotation.type === "highlight")
    .reduce(
      (text, annotation) => text.replace(annotation.text, "_____"),
      readerPageText
    );
  const emptyMessage =
    mode === "review" && reviewScope === "selected"
      ? "No due cards in this topic"
      : mode === "review"
        ? "No due cards to review"
        : mode === "study"
          ? "No active cards in this topic"
          : "No cards";

  const renderCardEditor = (card) => (
    <div
      key={card.id}
      style={{
        padding: 12,
        border: "1px solid #cbd5e1",
        borderRadius: 6,
        marginBottom: 10,
        background: "#ffffff",
      }}
    >
      <div style={{ marginBottom: 6 }}>
        <strong>
          Page {card.pageNumber || "?"} | {card.cardType || "card"} |{" "}
          {card.priority || "normal"}
        </strong>
      </div>

      {editingCardId === card.id ? (
        <div>
          <label>
            Question
            <textarea
              value={editingQuestion}
              onChange={(event) => setEditingQuestion(event.target.value)}
              style={{ display: "block", width: "100%", minHeight: 70, marginTop: 4 }}
            />
          </label>
          <label>
            Answer
            <textarea
              value={editingAnswer}
              onChange={(event) => setEditingAnswer(event.target.value)}
              style={{ display: "block", width: "100%", minHeight: 70, marginTop: 4 }}
            />
          </label>
          <div style={{ marginTop: 8 }}>
            <button onClick={() => saveEditedCard(card.id)}>Save</button>
            <button onClick={cancelEditCard} style={{ marginLeft: 8 }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ marginBottom: 6 }}>
            <strong>Q:</strong> {card.question}
          </div>
          <div style={{ marginBottom: 6 }}>
            <strong>A:</strong> {card.answer}
          </div>
          {card.sourceText && (
            <div style={{ color: "#475569", marginBottom: 6 }}>
              Source: {card.sourceText}
            </div>
          )}
          {card.aiReason && (
            <div style={{ color: "#475569", marginBottom: 6 }}>
              AI reason: {card.aiReason}
            </div>
          )}
          <div>
            <button onClick={() => startEditCard(card)}>Edit</button>
            <button onClick={() => deleteStudyCard(card.id)} style={{ marginLeft: 8 }}>
              Delete
            </button>
            <button onClick={() => goToCardPage(card)} style={{ marginLeft: 8 }}>
              Go to page
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ padding: 30 }}>
      <h1>Study App</h1>

      <button
        style={getModeButtonStyle("review")}
        onClick={() => {
          setReviewScope("all");
          startMode("review");
        }}
      >
        Review All
      </button>
      <button
        style={getModeButtonStyle("review-selected")}
        onClick={() => {
          setReviewScope("selected");
          startMode("review");
        }}
      >
        Review This Topic
      </button>
      <button
        style={getModeButtonStyle("study")}
        onClick={() => startMode("study")}
      >
        Study
      </button>
      <button
        style={getModeButtonStyle("hidden")}
        onClick={() => startMode("hidden")}
      >
        Hidden
      </button>
      <button
        style={getModeButtonStyle("browse")}
        onClick={() => startMode("browse")}
      >
        Browse
      </button>
      <button
        style={getModeButtonStyle("files")}
        onClick={() => startMode("files")}
      >
        Files
      </button>

      <hr />

      {(mode === "study" || (mode === "review" && reviewScope === "selected")) && (
        <p>Selected topic: {selectedDeckName}</p>
      )}

      {mode !== "hidden" && mode !== "browse" && mode !== "files" && (
        <p>
          Cards in session: {sessionCards.length}
        </p>
      )}
      {mode === "review" && (
        <p>
          Due for review:{" "}
          {reviewScope === "selected"
            ? dueCardsForSelectedDeck.length
            : dueCards.length}
        </p>
      )}
      <p>Hidden cards: {hiddenCards.length}</p>

      <hr />

      {mode === "browse" && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <button
              onClick={() => setBrowseFilter("all")}
              style={{
                background: browseFilter === "all" ? "#dbeafe" : "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                padding: "6px 10px",
              }}
            >
              All
            </button>
            <button
              onClick={() => setBrowseFilter("due")}
              style={{
                marginLeft: 8,
                background: browseFilter === "due" ? "#dbeafe" : "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                padding: "6px 10px",
              }}
            >
              Due
            </button>
            <button
              onClick={() => setBrowseFilter("weak")}
              style={{
                marginLeft: 8,
                background: browseFilter === "weak" ? "#dbeafe" : "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                padding: "6px 10px",
              }}
            >
              Weak
            </button>
          </div>

          {browseCards.length === 0 ? (
            <p>No cards</p>
          ) : (
            browseCards.map((card) => (
              <div
                key={card.id}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                <div>
                  <strong>{card.question}</strong>
                </div>
                <div>
                  Answer preview: {(card.answer || "").slice(0, 160)}
                  {(card.answer || "").length > 160 ? "..." : ""}
                </div>
                <div>
                  Page {card.pageNumber} | {card.deckName || card.pdfId}
                </div>
                <div>
                  PDF: {card.pdfId} | Lapses: {card.lapses || 0}
                </div>
                <div style={{ marginTop: 6 }}>
                  <button onClick={() => toggleBrowsePreview(card.id)}>
                    {browsePreviewCardId === card.id ? "Hide preview" : "Preview"}
                  </button>
                  <button
                    onClick={() => openCardInReview(card.id)}
                    style={{ marginLeft: 8 }}
                  >
                    Go
                  </button>
                  <button
                    onClick={() => deleteCard(card.id)}
                    style={{ marginLeft: 8 }}
                  >
                    Delete
                  </button>
                </div>
                {browsePreviewCardId === card.id && (
                  <div style={{ marginTop: 8 }}>
                    {browsePreviewImage ? (
                      <img
                        src={browsePreviewImage}
                        alt="Browse preview"
                        style={{ width: "100%", maxWidth: 260 }}
                      />
                    ) : (
                      <p>Loading preview...</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {mode === "hidden" && (
        <div style={{ marginBottom: 16 }}>
          <h3>Hidden cards</h3>
          {hiddenCards.length === 0 ? (
            <p>No hidden cards</p>
          ) : (
            decks.flatMap((deck) =>
              (deck.cards || [])
                .filter((card) => card.isSuspended)
                .map((card) => (
                  <div
                    key={card.id}
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  >
                    <div>
                      <strong>{card.question}</strong>
                    </div>
                    <div>
                      File: {deck.name} | Page: {card.pageNumber}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <button
                        onClick={() => {
                          setDecks((prev) =>
                            prev.map((currentDeck) => ({
                              ...currentDeck,
                              cards: currentDeck.cards.map((currentCard) =>
                                currentCard.id === card.id
                                  ? { ...currentCard, isSuspended: false }
                                  : currentCard
                              ),
                            }))
                          );

                          setSessionCards((prev) =>
                            prev.filter((sessionCard) => sessionCard.id !== card.id)
                          );
                          setShowAnswer(false);
                          setCurrentCardIndex(0);
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                ))
            )
          )}
        </div>
      )}

      {currentCard && (
        <div>
          <h3>{currentCard.question}</h3>

          {!showAnswer ? (
            <button onClick={() => setShowAnswer(true)}>
              Show Answer (Space)
            </button>
          ) : (
            <div>
              <div
                style={{
                  marginBottom: 12,
                  padding: 12,
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  background: "#f8fafc",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                }}
              >
                <strong>Answer:</strong> {currentCard.answer}
              </div>

              {currentImage && (
                <img
                  src={currentImage}
                  alt="PDF page"
                  style={{ width: "100%", maxWidth: 600, marginBottom: 12 }}
                />
              )}

              {mode !== "hidden" && (
                <div style={{ marginTop: 10 }}>
                  <button onClick={() => rateCard("Very Hard")}>
                    1 Very Hard
                  </button>
                  <button onClick={() => rateCard("Hard")}>2 Hard</button>
                  <button onClick={() => rateCard("Easy")}>3 Easy</button>
                  <button onClick={() => rateCard("Very Easy")}>
                    4 Very Easy
                  </button>
                  <button onClick={hideCard}>Hide</button>
                </div>
              )}

              {mode === "hidden" && (
                <button onClick={restoreCard}>Restore</button>
              )}
            </div>
          )}
        </div>
      )}

      {mode !== "browse" && mode !== "files" && sessionCards.length === 0 && (
        <p>{emptyMessage}</p>
      )}

      {mode === "files" && (
        <div style={{ marginTop: 24 }}>
          <h3>Files</h3>
          <div style={{ marginBottom: 16 }}>
            <input type="file" accept="application/pdf" onChange={handleFile} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <button onClick={cleanUnusedFiles}>Clean unused files</button>
            <span style={{ marginLeft: 10 }}>
              Unused: {mediaStatus.unusedPdfIds.length}
            </span>
            <span style={{ marginLeft: 10 }}>
              Missing: {mediaStatus.missingPdfIds.length}
            </span>
          </div>

          {aiStatus && (
            <div
              style={{
                marginBottom: 12,
                padding: 10,
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                background: aiBusy ? "#eff6ff" : "#f8fafc",
              }}
            >
              {aiStatus}
            </div>
          )}

          {decks.length === 0 ? (
            <p>No files loaded</p>
          ) : (
            <div style={{ marginBottom: 22 }}>
              {decks.map((deck) => (
                <div
                  key={deck.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 8,
                  }}
                >
                  <button
                    onClick={() => {
                      selectDeckForCurrentMode(deck.id);
                    }}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid #cbd5e1",
                      cursor: "pointer",
                      background:
                        selectedDeckId === deck.id ? "#dbeafe" : "#ffffff",
                    }}
                  >
                    {deck.name}
                  </button>
              <span>
                {deck.cards.filter((card) => card.cardType !== "source").length} cards
              </span>
                  <button onClick={() => openDeckInReader(deck)}>Open</button>
                  <button onClick={() => deleteDeck(deck.id)}>Delete</button>
                </div>
              ))}
            </div>
          )}

          {readerPdf && (
            <div>
              <h3>{readerDeck?.name || "PDF Reader"}</h3>
              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={() =>
                    setReaderPageNumber((pageNumber) =>
                      Math.max(1, pageNumber - 1)
                    )
                  }
                  disabled={readerPageNumber <= 1}
                >
                  Previous
                </button>
                <span style={{ margin: "0 10px" }}>
                  Page {readerPageNumber} / {readerPdf.numPages}
                </span>
                <button
                  onClick={() =>
                    setReaderPageNumber((pageNumber) =>
                      Math.min(readerPdf.numPages, pageNumber + 1)
                    )
                  }
                  disabled={readerPageNumber >= readerPdf.numPages}
                >
                  Next
                </button>
                <button
                  onClick={generateAiCardsForPage}
                  disabled={aiBusy}
                  style={{ marginLeft: 10 }}
                >
                  {aiBusy ? "Generating..." : "Generate current page"}
                </button>
                <button
                  onClick={copyPromptForChatGpt}
                  style={{ marginLeft: 10 }}
                >
                  Copy prompt for ChatGPT
                </button>
                <button
                  onClick={copyFilePromptForChatGpt}
                  style={{ marginLeft: 10 }}
                >
                  Copy whole-file prompt
                </button>
              </div>

              {copyStatus && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: 10,
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    background: "#f8fafc",
                  }}
                >
                  {copyStatus}
                </div>
              )}

              {aiStatus && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: 10,
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    background: aiBusy ? "#eff6ff" : "#f8fafc",
                  }}
                >
                  {aiStatus}
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={() => setReaderTool("comment")}
                  style={{
                    background: readerTool === "comment" ? "#dbeafe" : "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    padding: "6px 10px",
                  }}
                >
                  Comment
                </button>
                <button
                  onClick={() => setReaderTool("highlight")}
                  style={{
                    marginLeft: 8,
                    background:
                      readerTool === "highlight" ? "#fef3c7" : "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    padding: "6px 10px",
                  }}
                >
                  Highlight text
                </button>
              </div>

              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  background: "#f8fafc",
                }}
              >
                <h3>Import cards from ChatGPT</h3>
                <textarea
                  value={chatGptImportText}
                  onChange={(event) => setChatGptImportText(event.target.value)}
                  placeholder='Paste JSON here, for example: {"cards":[...]}'
                  style={{ width: "100%", minHeight: 120 }}
                />
                <button onClick={importCardsFromChatGpt} style={{ marginTop: 8 }}>
                  Import cards
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(320px, 720px) minmax(280px, 1fr)",
                  gap: 18,
                  alignItems: "start",
                }}
              >
                <div>
                  <div
                    onClick={addReaderComment}
                    style={{
                      position: "relative",
                      width: "100%",
                      maxWidth: 720,
                      border: "1px solid #cbd5e1",
                      cursor: readerTool === "comment" ? "crosshair" : "default",
                    }}
                  >
                    {readerImage ? (
                      <img
                        src={readerImage}
                        alt="PDF page"
                        style={{
                          display: "block",
                          width: "100%",
                          userSelect: "none",
                        }}
                      />
                    ) : (
                      <p style={{ padding: 16 }}>Loading page...</p>
                    )}
                    {readerPageAnnotations
                      .filter((annotation) => annotation.type === "comment")
                      .map((annotation) => (
                        <button
                          key={annotation.id}
                          title={annotation.text}
                          onClick={(event) => event.stopPropagation()}
                          style={{
                            position: "absolute",
                            left: `${annotation.x}%`,
                            top: `${annotation.y}%`,
                            transform: "translate(-50%, -50%)",
                            width: 24,
                            height: 24,
                            borderRadius: "50%",
                            border: "1px solid #92400e",
                            background: "#fbbf24",
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          C
                        </button>
                      ))}
                  </div>
                </div>

                <div>
                  <h3>AI Cards on this page</h3>
                  {readerPageCards.length === 0 ? (
                    <p>No cards for this page yet</p>
                  ) : (
                    readerPageCards.map((card) => renderCardEditor(card))
                  )}

                  <h3>Add card manually</h3>
                  <textarea
                    value={manualQuestion}
                    onChange={(event) => setManualQuestion(event.target.value)}
                    placeholder="Question"
                    style={{ display: "block", width: "100%", minHeight: 70 }}
                  />
                  <textarea
                    value={manualAnswer}
                    onChange={(event) => setManualAnswer(event.target.value)}
                    placeholder="Answer"
                    style={{
                      display: "block",
                      width: "100%",
                      minHeight: 70,
                      marginTop: 8,
                    }}
                  />
                  <button onClick={createManualCard} style={{ marginTop: 8 }}>
                    Save manual card
                  </button>

                  <h3>Raw PDF text</h3>
                  <button
                    onClick={addSelectedTextHighlight}
                    disabled={readerTool !== "highlight"}
                  >
                    Save selected text as cloze
                  </button>
                  <div
                    style={{
                      marginTop: 10,
                      padding: 12,
                      border: "1px solid #cbd5e1",
                      borderRadius: 6,
                      maxHeight: 220,
                      overflow: "auto",
                      lineHeight: 1.5,
                      background: "#ffffff",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {readerPageText || "No text found on this page"}
                  </div>

                  {readerPageAnnotations.some(
                    (annotation) => annotation.type === "highlight"
                  ) && (
                    <div style={{ marginTop: 16 }}>
                      <h3>Cloze preview</h3>
                      <div
                        style={{
                          padding: 12,
                          border: "1px solid #cbd5e1",
                          borderRadius: 6,
                          lineHeight: 1.5,
                          background: "#f8fafc",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {readerClozeText}
                      </div>
                    </div>
                  )}

                  <h3>Annotations</h3>
                  {readerPageAnnotations.length === 0 ? (
                    <p>No annotations on this page</p>
                  ) : (
                    readerPageAnnotations.map((annotation) => (
                      <div
                        key={annotation.id}
                        style={{
                          padding: "8px 0",
                          borderBottom: "1px solid #e5e7eb",
                        }}
                      >
                        <strong>
                          {annotation.type === "comment" ? "Comment" : "Cloze"}
                        </strong>
                        <div>{annotation.text}</div>
                        <div style={{ marginTop: 6 }}>
                          {annotation.type === "highlight" && (
                            <button
                              onClick={() => createClozeCardFromHighlight(annotation)}
                            >
                              Create card
                            </button>
                          )}
                          <button
                            onClick={() => deleteAnnotation(annotation.id)}
                            style={{ marginLeft: 8 }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div style={{ marginTop: 24 }}>
                <h3>All cards in this file</h3>
                {readerFileCards.length === 0 ? (
                  <p>No cards generated for this file yet</p>
                ) : (
                  readerFileCards.map((card) => renderCardEditor(card))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
