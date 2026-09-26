import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 思源宋体（可变字重）：本地自托管，按 unicode-range 分片按需加载
// import '@fontsource-variable/noto-serif-sc';
// import '@fontsource-variable/noto-serif-jp';
import { App } from './App';
import { AppProvider } from './state';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
