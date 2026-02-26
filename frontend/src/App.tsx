import { AnimatePresence, motion } from 'framer-motion'
import { Dashboard } from '@/components/Dashboard'

/**
 * App root — wraps Dashboard in AnimatePresence + a fade-in motion.div so
 * the entire page-level view transitions smoothly on mount (and in the future
 * when routes change).
 */
function App() {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key="dashboard"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <Dashboard />
      </motion.div>
    </AnimatePresence>
  )
}

export default App
