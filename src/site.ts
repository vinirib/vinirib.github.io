export const site = {
  name: 'Vinícius Ribeiro',
  handle: 'vinirib',
  title: 'Senior Backend Engineer',
  email: 'viniciusribeirosp@gmail.com',
  linkedin: 'https://www.linkedin.com/in/viniciusribeirosp/',
  github: 'https://github.com/vinirib',
  inquirySubject: 'Project inquiry',
};

export const mailto = (subject = site.inquirySubject) =>
  `mailto:${site.email}?subject=${encodeURIComponent(subject)}`;
