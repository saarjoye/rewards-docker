import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'tdesign-react/es/_util/react-19-adapter'
import 'tdesign-react/es/style/index.css'

import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Application root was not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
