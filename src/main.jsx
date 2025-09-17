import React from 'react'
import ReactDOM from 'react-dom/client'
import LabspaceGenerator from './App'
import './index.css'

// Global error handling
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
});

// Initialize React application
const root = ReactDOM.createRoot(document.getElementById('root'))

root.render(
  <React.StrictMode>
    <LabspaceGenerator />
  </React.StrictMode>
)

// Development hot reload
if (import.meta.hot) {
  import.meta.hot.accept('./App', () => {
    const NextApp = require('./App').default
    root.render(
      <React.StrictMode>
        <NextApp />
      </React.StrictMode>
    )
  })
}