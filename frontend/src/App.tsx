import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Dashboard } from '@/components/Dashboard'
import { SimulatorPage } from '@/pages/SimulatorPage'

type Tab = 'dashboard' | 'simulator'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'simulator', label: 'Simulator' },
]

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')

  return (
    <div>
      <nav className="sticky top-0 z-50 flex gap-1 border-b border-border bg-background/90 backdrop-blur-sm px-4 pt-3 pb-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={[
              'px-4 py-1.5 text-sm rounded-t-md border border-b-0 transition-colors',
              activeTab === tab.id
                ? 'border-border bg-card text-foreground font-semibold'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          {activeTab === 'dashboard' ? <Dashboard /> : <SimulatorPage />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export default App
