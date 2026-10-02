import { toast } from "./toast";

export function Settings({ count }: { count: number }) {
  console.log("Settings screen opened by the user");
  const save = () => toast({ title: "Changes saved" });
  return (
    <section className="flex flex-col gap-2 bg-card text-muted-foreground">
      <h1>Settings</h1>
      <p>You have {count} photos in your library.</p>
      <input placeholder="Search your photos" />
      <button aria-label="Close settings" onClick={save}>
        Save changes
      </button>
    </section>
  );
}
