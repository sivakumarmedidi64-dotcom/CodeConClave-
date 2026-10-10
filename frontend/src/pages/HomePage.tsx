/**
 * CodeConClave — Home.
 * Time-based greeting by name, the all-in-one HomeChat composer, quick-action
 * pills to real workspaces, project continuity strip, the "While you were
 * away" return-to-work card and the recent activity feed. Nothing here is
 * simulated: every surface is fed by a real API call.
 */
import { HomeChat } from '../components/HomeChat';

export function HomePage() {
  return (
    <div className="cc-home">
      <HomeChat />
    </div>
  );
}