import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getNextInterviewQuestion, InterviewQuestion } from '@/services/groq';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight, Bot, User, RotateCcw, CheckCircle2, Mic, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Message {
  role: 'ai' | 'user';
  content: string;
  type?: InterviewQuestion['type'];
  options?: { id: string; label: string }[];
  hint?: string;
  isRetryPrompt?: boolean;
}

const INITIAL_QUESTIONS = [
  { field: 'name', question: "What's your full name?", type: 'short_text' as const },
  { field: 'email', question: "What's your email address?", type: 'email' as const },
];

const VerticalScale = ({ className }: { className?: string }) => (
  <div className={cn("w-10 h-full bg-[repeating-linear-gradient(315deg,_#d4d4d4_0px,_#d4d4d4_1px,_transparent_1px,_transparent_10px)] bg-[length:14px_14px] border-x border-black/10", className)} />
);

const InterviewMode = () => {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [initStep, setInitStep] = useState(0);
  const [selectedOption, setSelectedOption] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    if (started) inputRef.current?.focus();
  }, [started, messages]);

  const startInterview = () => {
    if (!title.trim()) return;
    setStarted(true);
    setMessages([{
      role: 'ai',
      content: INITIAL_QUESTIONS[0].question,
      type: INITIAL_QUESTIONS[0].type,
    }]);
  };

  const handleSend = async () => {
    const value = selectedOption || currentInput.trim();
    if (!value || isLoading) return;

    const currentQ = messages.filter(m => m.role === 'ai' && !m.isRetryPrompt).at(-1);
    if (!currentQ) return;
    
    // Email validation for initial email question
    if (initStep === 1 && currentQ.type === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        toast.error("Please enter a valid email address");
        return;
      }
    }

    const newAnswers = [...answers, { question: currentQ.content, answer: value }];

    setMessages(prev => [...prev, { role: 'user', content: value }]);
    setAnswers(newAnswers);
    setCurrentInput('');
    setSelectedOption('');

    if (initStep < INITIAL_QUESTIONS.length - 1) {
      const nextStep = initStep + 1;
      setInitStep(nextStep);
      setTimeout(() => {
        setMessages(prev => [...prev, {
          role: 'ai',
          content: INITIAL_QUESTIONS[nextStep].question,
          type: INITIAL_QUESTIONS[nextStep].type,
        }]);
      }, 500);
      return;
    }

    if (initStep === INITIAL_QUESTIONS.length - 1) {
      setInitStep(INITIAL_QUESTIONS.length);
    }

    if (newAnswers.length >= 12) {
      setTimeout(() => {
        setMessages(prev => [...prev, {
          role: 'ai',
          content: "That's all the questions I have for you. Thank you for your time — your responses have been recorded!",
          type: 'short_text',
        }]);
        setIsComplete(true);
      }, 500);
      return;
    }

    setIsLoading(true);
    try {
      const next = await getNextInterviewQuestion(title, newAnswers);
      setMessages(prev => [...prev, {
        role: 'ai',
        content: next.question,
        type: next.type,
        options: next.options,
        hint: next.hint,
      }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to get next question";
      toast.error(message);
      setAnswers(answers);
      setMessages(prev => [...prev, {
        role: 'ai',
        content: "Sorry, I couldn't save that answer. Please resend your answer.",
        type: 'short_text',
        isRetryPrompt: true,
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const currentAiMessage = messages.filter(m => m.role === 'ai').at(-1);
  const isChoiceType = currentAiMessage?.type === 'single_choice' ||
    currentAiMessage?.type === 'multiple_choice' ||
    currentAiMessage?.type === 'yes_no';

  // ── SETUP SCREEN ────────────────────────────────────────────────────────────
  if (!started) {
    return (
      <div className="relative min-h-screen bg-[#F0F0F0] font-mono selection:bg-accent selection:text-accent-foreground overflow-hidden">
        <VerticalScale className="absolute inset-y-0 left-0" />
        <VerticalScale className="absolute inset-y-0 right-0" />
        <div className="fixed inset-0 pointer-events-none opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '20px 20px' }} />

        {/* Nav */}
        <nav className="border-b border-foreground bg-background sticky top-0 z-50">
          <div className="container mx-auto flex items-center justify-between px-4 py-4">
            <Link to="/" className="text-[24px] font-sans font-medium tracking-tight hover:text-accent transition-colors">
              aqora
            </Link>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-bold uppercase tracking-widest opacity-40 hidden md:block">AI Interview Mode</span>
              <Link to="/dashboard" className="border border-foreground px-4 py-2 text-xs font-bold hover:bg-foreground hover:text-background transition-all">
                ← Dashboard
              </Link>
            </div>
          </div>
        </nav>

        <main className="container mx-auto px-4 py-20 relative z-10 max-w-2xl">
          {/* Header */}
          <div className="mb-12">
            <div className="inline-flex items-center gap-2 border border-foreground bg-background px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest mb-6">
              <Mic className="h-3 w-3" /> Interview Mode
            </div>
            <h1 className="text-5xl md:text-7xl font-black uppercase italic tracking-tighter leading-none mb-4 font-sans">
              AI<br />INTERVIEW<span className="text-accent">.</span>
            </h1>
            <p className="text-base font-medium opacity-60 max-w-md leading-relaxed">
              Enter a title and the AI conducts a dynamic, adaptive interview — asking follow-up questions based on your answers, one at a time.
            </p>
          </div>

          {/* Input card */}
          <div className="border border-foreground bg-background shadow-[6px_6px_0px_#000] p-8">
            <label className="text-[10px] font-black uppercase tracking-widest opacity-50 block mb-3">
              Interview Title *
            </label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && startInterview()}
              placeholder="e.g. Frontend Developer Interview"
              className="w-full border border-foreground bg-[#F0F0F0] px-4 py-3 text-base font-medium outline-none focus:bg-background transition-colors font-sans placeholder:opacity-40 mb-6"
              autoFocus
            />

            {/* Quick examples */}
            <div className="mb-6">
              <p className="text-[10px] font-bold uppercase tracking-widest opacity-40 mb-3">Quick start</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  'Frontend Developer Interview',
                  'Product Manager Screening',
                  'Customer Satisfaction Survey',
                  'UX Research Session',
                ].map(ex => (
                  <button
                    key={ex}
                    onClick={() => setTitle(ex)}
                    className="text-left border border-foreground/30 bg-[#F0F0F0] hover:border-foreground hover:bg-background px-3 py-2.5 text-xs font-medium transition-all"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={startInterview}
              disabled={!title.trim()}
              className="w-full border border-foreground bg-foreground text-background px-8 py-4 text-sm font-black uppercase tracking-widest hover:shadow-[4px_4px_0px_#000] hover:translate-x-[-2px] hover:translate-y-[-2px] transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              Begin Interview <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          {/* How it works */}
          <div className="mt-8 border border-foreground/20 bg-background p-6">
            <p className="text-[10px] font-black uppercase tracking-widest opacity-40 mb-4">How it works</p>
            <div className="space-y-3">
              {[
                ['01', 'AI asks for your name and email first'],
                ['02', 'Then asks a primary skill question based on the title'],
                ['03', 'Dynamic follow-up questions adapt to your answers'],
                ['04', 'Up to 12 questions total — natural and conversational'],
              ].map(([n, t]) => (
                <div key={n} className="flex items-start gap-3 text-sm">
                  <span className="text-[10px] font-black opacity-30 mt-0.5 font-mono">{n}</span>
                  <span className="font-medium opacity-70">{t}</span>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ── INTERVIEW SCREEN ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F0F0F0] font-mono flex flex-col selection:bg-accent selection:text-accent-foreground">
      <div className="fixed inset-0 pointer-events-none opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '20px 20px' }} />

      {/* Header */}
      <nav className="border-b border-foreground bg-background sticky top-0 z-50">
        <div className="container mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-[20px] font-sans font-medium tracking-tight hover:text-accent transition-colors">
              aqora
            </Link>
            <div className="w-px h-5 bg-foreground/20" />
            <div>
              <p className="text-sm font-bold font-sans leading-none">{title}</p>
              <p className="text-[10px] font-mono uppercase tracking-widest opacity-40 mt-0.5">
                AI Interview · {answers.length} answered
              </p>
            </div>
          </div>
          <button
            onClick={() => { setStarted(false); setMessages([]); setAnswers([]); setInitStep(0); setIsComplete(false); setTitle(''); setCurrentInput(''); setSelectedOption(''); setIsLoading(false); }}
            className="flex items-center gap-1.5 border border-foreground/30 hover:border-foreground px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all"
          >
            <RotateCcw className="h-3 w-3" /> Restart
          </button>
        </div>
      </nav>

      {/* Progress bar */}
      <div className="h-0.5 bg-foreground/10">
        <div
          className="h-full bg-accent transition-all duration-500"
          style={{ width: `${Math.min((answers.length / 12) * 100, 100)}%` }}
        />
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-10 max-w-2xl mx-auto w-full space-y-6 relative z-10">
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className={cn("flex gap-3", msg.role === 'user' ? "flex-row-reverse" : "flex-row")}
            >
              {/* Avatar */}
              <div className={cn(
                "w-8 h-8 border border-foreground flex items-center justify-center shrink-0 mt-1 font-black text-[10px]",
                msg.role === 'ai' ? "bg-foreground text-background" : "bg-accent text-background"
              )}>
                {msg.role === 'ai' ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
              </div>

              {/* Bubble */}
              <div className={cn(
                "max-w-[80%] border px-4 py-3 text-sm font-sans",
                msg.role === 'ai'
                  ? "border-foreground bg-background shadow-[3px_3px_0px_#000]"
                  : "border-foreground bg-foreground text-background"
              )}>
                <p className="leading-relaxed">{msg.content}</p>
                {msg.hint && (
                  <p className="text-[11px] opacity-50 mt-1.5 border-t border-current/20 pt-1.5 italic">{msg.hint}</p>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Typing indicator */}
        {isLoading && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-3">
            <div className="w-8 h-8 border border-foreground bg-foreground text-background flex items-center justify-center shrink-0">
              <Bot className="h-4 w-4" />
            </div>
            <div className="border border-foreground bg-background px-4 py-3 flex items-center gap-1.5 shadow-[3px_3px_0px_#000]">
              {[0, 1, 2].map(i => (
                <motion.div
                  key={i}
                  animate={{ opacity: [0.2, 1, 0.2] }}
                  transition={{ duration: 0.8, delay: i * 0.2, repeat: Infinity }}
                  className="w-1.5 h-1.5 bg-foreground"
                />
              ))}
            </div>
          </motion.div>
        )}

        {/* Complete state */}
        {isComplete && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="border border-foreground bg-background p-8 text-center shadow-[6px_6px_0px_#000]"
          >
            <CheckCircle2 className="h-10 w-10 mx-auto mb-4 text-accent" />
            <p className="text-2xl font-black uppercase tracking-tight font-sans mb-1">Interview Complete!</p>
            <p className="text-sm opacity-50 mb-6 font-sans">{answers.length} questions answered</p>
            <button
              onClick={() => navigate('/dashboard')}
              className="border border-foreground bg-foreground text-background px-8 py-3 text-sm font-black uppercase tracking-widest hover:shadow-[4px_4px_0px_#000] hover:translate-x-[-2px] hover:translate-y-[-2px] transition-all"
            >
              Back to Dashboard →
            </button>
          </motion.div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {!isComplete && (
        <div className="border-t border-foreground bg-background sticky bottom-0 z-50">
          <div className="max-w-2xl mx-auto px-4 py-4">
            {/* Choice options */}
            {isChoiceType && currentAiMessage?.options && currentAiMessage.options.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {currentAiMessage.options.map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setSelectedOption(opt.label)}
                    className={cn(
                      "px-3 py-1.5 text-xs font-bold border uppercase tracking-wider transition-all",
                      selectedOption === opt.label
                        ? "bg-foreground text-background border-foreground"
                        : "bg-background border-foreground/30 hover:border-foreground"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            {/* Yes/No */}
            {currentAiMessage?.type === 'yes_no' && !currentAiMessage?.options?.length && (
              <div className="flex gap-2 mb-3">
                {['Yes', 'No'].map(opt => (
                  <button
                    key={opt}
                    onClick={() => setSelectedOption(opt)}
                    className={cn(
                      "px-6 py-2 text-xs font-black border uppercase tracking-widest transition-all",
                      selectedOption === opt
                        ? "bg-foreground text-background border-foreground"
                        : "bg-background border-foreground/30 hover:border-foreground"
                    )}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-center">
              <input
                ref={inputRef}
                value={selectedOption || currentInput}
                onChange={e => { setCurrentInput(e.target.value); setSelectedOption(''); }}
                onKeyDown={handleKeyDown}
                placeholder={isChoiceType ? "Or type your answer..." : "Type your answer..."}
                disabled={isLoading}
                type={currentAiMessage?.type === 'email' ? 'email' : 'text'}
                className="flex-1 border border-foreground bg-[#F0F0F0] px-4 py-3 text-sm font-sans outline-none focus:bg-background transition-colors placeholder:opacity-40 disabled:opacity-40"
              />
              <button
                onClick={handleSend}
                disabled={isLoading || (!currentInput.trim() && !selectedOption)}
                className="border border-foreground bg-foreground text-background p-3 hover:shadow-[3px_3px_0px_#000] hover:translate-x-[-1px] hover:translate-y-[-1px] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <CornerDownLeft className="h-5 w-5" />
              </button>
            </div>
            <p className="text-[10px] font-mono uppercase tracking-widest opacity-30 mt-2 text-center">
              Press Enter to send · {Math.max(0, 12 - answers.length)} questions remaining
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default InterviewMode;
