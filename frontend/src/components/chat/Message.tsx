import { motion, type Variants } from 'framer-motion'
import type { UIMessage } from 'ai'
import { isTextUIPart, isToolUIPart } from 'ai'
import { ToolRenderer } from './ToolRenderer'

interface MessageProps {
  message: UIMessage
}

/** Subtle slide-up + fade-in for new messages */
const messageVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
}

/**
 * Message — Renders a single chat message bubble.
 *
 * AI SDK v6 uses a `parts` array on each message instead of a flat `content`
 * string + `toolInvocations`. This component iterates over the parts array and
 * delegates tool parts to ToolRenderer for Generative UI rendering.
 *
 * - User messages appear on the right with a primary accent background.
 * - Assistant messages appear on the left with a muted background.
 */
export function Message({ message }: MessageProps) {
  const isUser = message.role === 'user'

  // Extract text content from text parts for display
  const textContent = message.parts
    .filter(isTextUIPart)
    .map((p) => p.text)
    .join('')

  // Extract tool invocation parts (static or dynamic) for Generative UI
  const toolParts = message.parts.filter(isToolUIPart)

  return (
    <motion.div
      layout
      variants={messageVariants}
      initial="hidden"
      animate="visible"
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-muted text-foreground rounded-bl-sm'
        }`}
      >
        {/* Text content — may be empty when the message contains only tool calls */}
        {textContent && (
          <p className="whitespace-pre-wrap">{textContent}</p>
        )}

        {/* Generative UI: render tool invocations as specialized components */}
        {toolParts.length > 0 && (
          <div className={`space-y-2 ${textContent ? 'mt-2' : ''}`}>
            {toolParts.map((part, idx) => (
              <ToolRenderer key={`${message.id}-tool-${idx}`} toolPart={part} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}
