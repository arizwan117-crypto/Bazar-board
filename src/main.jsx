
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

const root = document.getElementById('root')

window.addEventListener('error', (e) => {
  const pre = document.createElement('pre')
  pre.style.color = 'red'
  pre.style.whiteSpace = 'pre-wrap'
  pre.style.padding = '16px'
  pre.style.fontFamily = 'monospace'
  pre.style.fontSize = '12px'
  pre.textContent = 'ERROR: ' + (e.error && e.error.stack ? e.error.stack : e.message)
  document.body.appendChild(pre)
})

try {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
} catch (e) {
  root.innerHTML = '<pre style="color:red;white-space:pre-wrap;padding:16px;font-family:monospace;font-size:12px">' + (e && e.stack ? e.stack : String(e)) + '</pre>'
}
