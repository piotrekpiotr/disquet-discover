import Link from "next/link";

export default function RecordNotFound() {
  return (
    <div className="px-6 sm:px-8 pt-24 pb-24 max-w-2xl">
      <h1
        className="font-display font-black text-[56px] sm:text-[96px] leading-[0.9]"
        style={{ letterSpacing: "-0.035em" }}
      >
        Not found
        <span
          className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
          style={{ letterSpacing: "0" }}
        >
          no record at this address
        </span>
      </h1>
      <p className="font-body text-[17px] mt-8 text-ink/80 max-w-[52ch]">
        Either this record doesn&apos;t exist, or it isn&apos;t published. Head
        back to the{" "}
        <Link href="/" className="border-b border-ink hover:text-signal hover:border-signal">
          feed
        </Link>{" "}
        to browse the latest picks.
      </p>
    </div>
  );
}
