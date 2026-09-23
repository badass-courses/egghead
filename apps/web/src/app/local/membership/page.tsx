import { MembershipPage } from "../../../local-membership/membership-page";

export default function LocalMembershipPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <MembershipPage {...props} configuration />;
}
