/**
 * CodeConClave — Home.
 * Time-based greeting by name, the morning briefing hero, then the all-in-one
 * HomeChat composer. Nothing here is simulated: the greeting derives from the
 * real session user and every surface below is fed by a real API call.
 */
import { HomeChat } from '../components/HomeChat';
import { MorningBrief } from '../components/MorningBrief';
import { useAuth } from '../auth/AuthProvider';
import { BrandLogo } from '../components/BrandLogo';
import { WelcomeName } from '../components/WelcomeName';
import { usePref } from '../lib/prefs';

function dayPart(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

export function greetingFor(date: Date, displayName: string | null | undefined, email: string | null | undefined): string {
  const raw = (displayName ?? '').trim() || ((email ?? '').split('@')[0] ?? '');
  const first = raw.trim().split(/\s+/)[0] ?? '';
  const name = first || 'there';
  return `Good ${dayPart(date.getHours())}, ${name}.`;
}

export function HomePage() {
  // Home always renders inside AuthProvider (App shell + tests mock it).
  const { user } = useAuth();
  // Personalization's "call me" wins over the account display name.
  const callMe = usePref<string>('call_me');
  const heading = greetingFor(new Date(), (callMe && callMe.trim()) || user?.displayName || null, user?.email ?? null);
  return (
    <div className="cc-home cc-home--v2">
      <div className="cc-home__greeting">
        <BrandLogo variant="mark" height={34} className="cc-home__mark" />
        <h1>{heading}</h1>
      </div>
      <HomeChat hero={false} />
      <MorningBrief greeting={false} />
      <WelcomeName />
    </div>
  );
}
