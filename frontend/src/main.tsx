import { createRoot } from 'react-dom/client';
import StudioApp from './App';

const el = document.getElementById('root');
if (!el) throw new Error('#root element missing in index.html');
createRoot(el).render(<StudioApp />);
